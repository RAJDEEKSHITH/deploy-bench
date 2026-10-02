import {createCipheriv, createDecipheriv, randomBytes} from "node:crypto";
import { env } from "../config/env.js";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

let cachedKey: Buffer | null = null;

export interface EncryptedData {
  ciphertext: string;
  iv: string;
  authTag: string;
}

const getEncryptionKey = (): Buffer => {
 if (cachedKey) return cachedKey;
  cachedKey = Buffer.from(env.APP_ENCRYPTION_KEY, "hex");
  return cachedKey;
};

export const encrypt = (plaintext: string) : EncryptedData => {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH); // fresh random IV for every encryption.

  const cipher = createCipheriv(ENCRYPTION_ALGORITHM,key,iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
};

export const decrypt = ({ ciphertext, iv, authTag }: EncryptedData): string => {
    
  const key = getEncryptionKey();

  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM,key,Buffer.from(iv, "base64"));

  decipher.setAuthTag(Buffer.from(authTag, "base64"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
};