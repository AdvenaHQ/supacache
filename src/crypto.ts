/**
 * Derives a CryptoKey for AES-GCM encryption and decryption from a given secret key.
 *
 * @param secretKey - The secret key used to derive the CryptoKey. It can be a string or undefined.
 * @returns A Promise that resolves to a CryptoKey object that can be used for encryption and decryption.
 *
 * @throws If the secretKey is undefined or if there is an error during the key import process.
 */
export const getEncryptionKey = (secretKey: string | undefined) => {
    // Initialise a new text encoder
    const encoder = new TextEncoder();

    // Convert the secret key to a Uint8Array
    const keyMaterial = encoder.encode(secretKey);

    // Derive the CryptoKey from the key material
    return crypto.subtle.importKey(
        "raw",
        keyMaterial,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"],
    );
};

/**
 * Encrypts the given data using AES-GCM with the provided key.
 *
 * @param data - The plaintext data to be encrypted.
 * @param key - The CryptoKey to be used for encryption.
 *
 * @returns A promise that resolves to a base64-encoded string containing the IV and ciphertext, separated by a colon.
 */
export const encrypt = async (data: string, key: CryptoKey) => {
    // Initialise a new text encoder
    const encoder = new TextEncoder();

    // Generate a random 96-bit initialisation vector (IV)
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // Encode the plaintext data as a Uint8Array
    const encodedData = encoder.encode(data);

    // Encrypt the data using AES-GCM with the provided key and IV
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        encodedData,
    );

    // Return the IV and ciphertext as a base64-encoded string
    return `${arrayBufferToBase64(iv)}:${arrayBufferToBase64(ciphertext)}`;
};

/**
 * Decrypts the provided encrypted data using AES-GCM with the given key.
 *
 * @param encryptedData - The encrypted data in the format "IV:ciphertext", both encoded in base64.
 * @param key - The CryptoKey to use for decryption.
 *
 * @returns A promise that resolves to the decrypted data as a UTF-8 string.
 */
export const decrypt = async (encryptedData: string, key: CryptoKey) => {
    // Split the encrypted data into the initialisation vector (IV) and ciphertext
    const [ivBase64, ciphertextBase64] = encryptedData.split(":");

    // Convert the IV from base64 to ArrayBuffer
    const iv = base64ToArrayBuffer(ivBase64);

    // Convert the ciphertext from base64 to ArrayBuffer
    const ciphertext = base64ToArrayBuffer(ciphertextBase64);

    // Decrypt the data using AES-GCM with the provided key and IV
    const decryptedData = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        ciphertext,
    );

    // Decode the decrypted data as a UTF-8 string
    return new TextDecoder().decode(decryptedData);
};

/**
 * Converts an ArrayBuffer to a base64-encoded string.
 *
 * @param buffer - The ArrayBuffer to convert.
 *
 * @returns The base64-encoded string representation of the ArrayBuffer.
 */
const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
    // Return the base64-encoded string
    return btoa(
        // Convert the ArrayBuffer to a Uint8Array
        String.fromCharCode(
            // Convert the ArrayBuffer to a Uint8Array
            ...new Uint8Array(buffer),
        ),
    );
};

/**
 * Converts a base64 encoded string to an ArrayBuffer.
 *
 * @param {string} base64 - The base64 encoded string to convert.
 *
 * @returns {ArrayBuffer} The resulting ArrayBuffer.
 */
const base64ToArrayBuffer = (base64: string) => {
    // Decode the base64 string
    const binary = atob(base64);

    // Create a new Uint8Array
    const array = new Uint8Array(binary.length);

    // Populate the Uint8Array with the binary data
    for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);

    // Return the ArrayBuffer
    return array.buffer;
};
