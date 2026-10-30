// File keystore in $GUARD_HOME (default ./.guard, git-ignored). Files are chmod 600.
// Layout:
//   config.json            { accountId, ownerPublicKey, agentKeys: { <contract>: <publicKey> } }
//   keys/<base58pub>.key   NEAR secret key string
import fs from 'node:fs';
import path from 'node:path';
import { KeyPair } from './near/keys.ts';
import { assertTestnetAccount } from './near/rpc.ts';

export interface GuardConfig {
  accountId: string;
  ownerPublicKey: string;
  agentKeys: Record<string, string>;
}

export class KeyStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'keys'), { recursive: true, mode: 0o700 });
  }

  private keyFile(publicKey: string): string {
    return path.join(this.dir, 'keys', publicKey.replace('ed25519:', '') + '.key');
  }

  saveKey(kp: KeyPair): void {
    fs.writeFileSync(this.keyFile(kp.publicKey), kp.secretKey, { mode: 0o600 });
  }

  loadKey(publicKey: string): KeyPair {
    const f = this.keyFile(publicKey);
    if (!fs.existsSync(f)) throw new Error(`no local secret for ${publicKey}`);
    const kp = KeyPair.fromString(fs.readFileSync(f, 'utf8').trim());
    if (kp.publicKey !== publicKey) throw new Error('keystore corruption: public key mismatch');
    return kp;
  }

  hasConfig(): boolean {
    return fs.existsSync(path.join(this.dir, 'config.json'));
  }

  readConfig(): GuardConfig {
    const c = JSON.parse(fs.readFileSync(path.join(this.dir, 'config.json'), 'utf8')) as GuardConfig;
    assertTestnetAccount(c.accountId);
    return c;
  }

  writeConfig(c: GuardConfig): void {
    assertTestnetAccount(c.accountId);
    fs.writeFileSync(path.join(this.dir, 'config.json'), JSON.stringify(c, null, 2), { mode: 0o600 });
  }
}
