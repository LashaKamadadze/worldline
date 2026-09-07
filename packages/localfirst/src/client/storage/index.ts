export { assertStorageName, type StorageAdapter } from './adapter';
export { MemoryStorage, StorageFault, type FaultHook, type StorageOp } from './memory';
export { NodeFsStorage } from './node_fs';
export { OpfsStorage } from './opfs';
