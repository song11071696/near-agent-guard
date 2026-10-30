// NEAR transaction model + Borsh serialization + signing (protocol Transaction V0 layout).
import crypto from 'node:crypto';
import { BorshWriter, base58Decode, base58Encode } from './encoding.ts';
import { KeyPair, publicKeyBytes } from './keys.ts';

export type AccessKeyPermission =
  | { type: 'FullAccess' }
  | { type: 'FunctionCall'; allowance: bigint | null; receiverId: string; methodNames: string[] };

export type Action =
  | { type: 'CreateAccount' }
  | { type: 'DeployContract'; code: Uint8Array }
  | { type: 'FunctionCall'; methodName: string; args: Uint8Array; gas: bigint; deposit: bigint }
  | { type: 'Transfer'; deposit: bigint }
  | { type: 'AddKey'; publicKey: string; nonce: bigint; permission: AccessKeyPermission }
  | { type: 'DeleteKey'; publicKey: string }
  | { type: 'DeleteAccount'; beneficiaryId: string };

export interface Transaction {
  signerId: string;
  publicKey: string;
  nonce: bigint;
  receiverId: string;
  blockHash: string; // base58
  actions: Action[];
}

function writePublicKey(w: BorshWriter, pk: string): void {
  w.u8(0); // KeyType::ED25519
  w.fixed(publicKeyBytes(pk));
}

function writePermission(w: BorshWriter, p: AccessKeyPermission): void {
  if (p.type === 'FullAccess') {
    w.u8(1);
    return;
  }
  w.u8(0);
  if (p.allowance === null) w.u8(0);
  else w.u8(1).u128(p.allowance);
  w.string(p.receiverId);
  w.vec(p.methodNames, (ww, m) => ww.string(m));
}

function writeAction(w: BorshWriter, a: Action): void {
  switch (a.type) {
    case 'CreateAccount':
      w.u8(0);
      break;
    case 'DeployContract':
      w.u8(1).bytes(a.code);
      break;
    case 'FunctionCall':
      w.u8(2).string(a.methodName).bytes(a.args).u64(a.gas).u128(a.deposit);
      break;
    case 'Transfer':
      w.u8(3).u128(a.deposit);
      break;
    case 'AddKey':
      w.u8(5);
      writePublicKey(w, a.publicKey);
      w.u64(a.nonce);
      writePermission(w, a.permission);
      break;
    case 'DeleteKey':
      w.u8(6);
      writePublicKey(w, a.publicKey);
      break;
    case 'DeleteAccount':
      w.u8(7).string(a.beneficiaryId);
      break;
  }
}

export function serializeTransaction(tx: Transaction): Uint8Array {
  const w = new BorshWriter();
  w.string(tx.signerId);
  writePublicKey(w, tx.publicKey);
  w.u64(tx.nonce);
  w.string(tx.receiverId);
  const bh = base58Decode(tx.blockHash);
  if (bh.length !== 32) throw new Error('block hash must be 32 bytes');
  w.fixed(bh);
  w.vec(tx.actions, writeAction);
  return w.toBytes();
}

export interface SignedTransaction {
  hash: string; // base58 tx hash
  bytes: Uint8Array; // borsh SignedTransaction
  signature: Uint8Array;
}

export function signTransaction(tx: Transaction, key: KeyPair): SignedTransaction {
  if (key.publicKey !== tx.publicKey) throw new Error('signing key does not match transaction public key');
  const body = serializeTransaction(tx);
  const digest = new Uint8Array(crypto.createHash('sha256').update(body).digest());
  const signature = key.sign(digest);
  const w = new BorshWriter().fixed(body).u8(0).fixed(signature);
  return { hash: base58Encode(digest), bytes: w.toBytes(), signature };
}
