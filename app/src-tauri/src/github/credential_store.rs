//! Windows account records use user-scoped DPAPI. Other platforms retain the
//! explicit private-file mode; they must not be described as OS-encrypted.
use crate::error::AppError;

pub fn encode(bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    if bytes.len() > 64 * 1024 {
        return Err(AppError::new(
            "account_store_limit",
            "Account record is oversized.",
        ));
    }
    #[cfg(windows)]
    {
        let data = windows::crypt(bytes, true)?;
        Ok(serde_json::to_vec(
            &serde_json::json!({"format":"windows-dpapi-v1","data":data}),
        )?)
    }
    #[cfg(not(windows))]
    {
        Ok(bytes.to_vec())
    }
}

pub fn decode(bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    if bytes.len() > 128 * 1024 {
        return Err(AppError::new(
            "account_store_limit",
            "Account record is oversized.",
        ));
    }
    let document: serde_json::Value = serde_json::from_slice(bytes)?;
    if document.get("format").and_then(|v| v.as_str()) == Some("windows-dpapi-v1") {
        let data: Vec<u8> = serde_json::from_value(
            document
                .get("data")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        )?;
        #[cfg(windows)]
        {
            return windows::crypt(&data, false);
        }
        #[cfg(not(windows))]
        {
            let _ = data;
            return Err(AppError::new(
                "account_store_platform",
                "This record requires its original Windows user profile.",
            ));
        }
    }
    // Preserve existing records without silently rewriting them during status reads.
    Ok(bytes.to_vec())
}

pub fn storage_kind(bytes: &[u8]) -> &'static str {
    if serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .and_then(|v| v.get("format").and_then(|x| x.as_str()).map(str::to_string))
        .as_deref()
        == Some("windows-dpapi-v1")
    {
        "windows_dpapi"
    } else {
        "private_file_unencrypted"
    }
}

#[cfg(windows)]
mod windows {
    use super::AppError;
    use std::ffi::c_void;
    #[repr(C)]
    struct Blob {
        length: u32,
        data: *mut u8,
    }
    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            input: *mut Blob,
            description: *const u16,
            entropy: *mut Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *mut Blob,
            description: *mut *mut u16,
            entropy: *mut Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }

    pub fn crypt(bytes: &[u8], protect: bool) -> Result<Vec<u8>, AppError> {
        if bytes.is_empty() || bytes.len() > 128 * 1024 {
            return Err(AppError::new(
                "account_store_limit",
                "Invalid protected account record size.",
            ));
        }
        // DPAPI's ABI requires a mutable pointer; use owned writable input.
        let mut owned = bytes.to_vec();
        let mut input = Blob {
            length: owned.len() as u32,
            data: owned.as_mut_ptr(),
        };
        let mut output = Blob {
            length: 0,
            data: std::ptr::null_mut(),
        };
        // UI_FORBIDDEN, not LOCAL_MACHINE: encryption remains user-scoped.
        let success = unsafe {
            if protect {
                CryptProtectData(
                    &mut input,
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    1,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &mut input,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    1,
                    &mut output,
                )
            }
        };
        let result = if success != 0 && !output.data.is_null() && output.length <= 128 * 1024 {
            Ok(unsafe { std::slice::from_raw_parts(output.data, output.length as usize) }.to_vec())
        } else {
            Err(AppError::new(
                "account_store_protection",
                "Windows could not protect or unlock the account record.",
            ))
        };
        if !output.data.is_null() {
            unsafe {
                LocalFree(output.data.cast());
            }
        }
        owned.fill(0);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn account_storage_roundtrips_without_credentials() {
        let bytes = br#"{"fixture":"not-an-account"}"#;
        let encoded = encode(bytes).unwrap();
        assert_eq!(decode(&encoded).unwrap(), bytes);
        #[cfg(windows)]
        {
            assert_eq!(storage_kind(&encoded), "windows_dpapi");
            assert!(!String::from_utf8_lossy(&encoded).contains("not-an-account"));
        }
    }
}
