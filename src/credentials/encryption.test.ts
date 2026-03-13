import { decrypt, encrypt } from './encryption';

describe('encryption', () => {
  const password = 'correct-horse-battery-staple';

  it('round-trips plaintext', () => {
    const plaintext = JSON.stringify({ hello: 'world' });
    const ciphertext = encrypt(plaintext, password);
    expect(decrypt(ciphertext, password)).toBe(plaintext);
  });

  it('produces binary output that is not the plaintext', () => {
    const plaintext = 'super-secret';
    const ciphertext = encrypt(plaintext, password);
    expect(ciphertext.toString('utf8')).not.toContain(plaintext);
  });

  it('throws with wrong password', () => {
    const ciphertext = encrypt('secret', password);
    expect(() => decrypt(ciphertext, 'wrong-password')).toThrow();
  });

  it('each encrypt call produces different ciphertext (random salt/iv)', () => {
    const a = encrypt('same', password);
    const b = encrypt('same', password);
    expect(a.equals(b)).toBe(false);
  });
});
