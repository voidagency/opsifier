const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const LENGTH = 20;

/** The same shape the server generates: strong, and safe in any URL or shell. */
export function generateStrongPassword(): string {
  const limit = 256 - (256 % ALPHABET.length);
  let password = "";
  while (password.length < LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(LENGTH * 2))) {
      if (byte < limit && password.length < LENGTH) {
        password += ALPHABET[byte % ALPHABET.length];
      }
    }
  }
  return password;
}
