// Browser-safe adapters only. `NodeFsStorage` lives at 'stdb-localfirst/client/node'
// because it imports node:fs, which browser bundlers cannot resolve.
export { assertStorageName, type StorageAdapter } from './adapter';
export { MemoryStorage, StorageFault, type FaultHook, type StorageOp } from './memory';
export { OpfsStorage } from './opfs';
