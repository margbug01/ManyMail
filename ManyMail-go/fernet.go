package main

// Fernet (https://github.com/fernet/spec), only what the sender-key store needs, so keys
// that mail-viewer encrypted with Python's cryptography library stay readable.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"time"
)

type fernet struct{ signKey, encKey []byte }

// senderKeyCipher derives the key exactly like mail-viewer's _sender_key_cipher.
func senderKeyCipher(secret string) fernet {
	d := sha256.Sum256([]byte("manymail-sender-keys:" + secret))
	return fernet{signKey: d[:16], encKey: d[16:]}
}

func (f fernet) mac(b []byte) []byte {
	m := hmac.New(sha256.New, f.signKey)
	m.Write(b)
	return m.Sum(nil)
}

func (f fernet) Encrypt(plain []byte) string {
	iv := make([]byte, aes.BlockSize)
	rand.Read(iv)
	pad := aes.BlockSize - len(plain)%aes.BlockSize
	buf := append(append([]byte{}, plain...), make([]byte, pad)...)
	for i := len(plain); i < len(buf); i++ {
		buf[i] = byte(pad)
	}
	block, _ := aes.NewCipher(f.encKey)
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(buf, buf)

	tok := make([]byte, 9, 9+len(iv)+len(buf)+32)
	tok[0] = 0x80
	binary.BigEndian.PutUint64(tok[1:9], uint64(time.Now().Unix()))
	tok = append(append(tok, iv...), buf...)
	return base64.URLEncoding.EncodeToString(append(tok, f.mac(tok)...))
}

var errBadToken = errors.New("invalid fernet token")

func (f fernet) Decrypt(token string) ([]byte, error) {
	b, err := base64.URLEncoding.DecodeString(token)
	if err != nil || len(b) < 1+8+16+16+32 || b[0] != 0x80 || (len(b)-1-8-16-32)%aes.BlockSize != 0 {
		return nil, errBadToken
	}
	body, sig := b[:len(b)-32], b[len(b)-32:]
	if !hmac.Equal(sig, f.mac(body)) {
		return nil, errBadToken
	}
	iv, ct := body[9:25], append([]byte{}, body[25:]...)
	block, _ := aes.NewCipher(f.encKey)
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(ct, ct)
	pad := int(ct[len(ct)-1])
	if pad == 0 || pad > aes.BlockSize {
		return nil, errBadToken
	}
	for _, p := range ct[len(ct)-pad:] {
		if int(p) != pad {
			return nil, errBadToken
		}
	}
	return ct[:len(ct)-pad], nil
}
