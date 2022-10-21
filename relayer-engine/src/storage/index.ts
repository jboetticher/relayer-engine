import {
  Plugin,
  StagingArea,
  Workflow,
  WorkflowId,
} from "relayer-plugin-interface";
import { CommonEnv } from "../config";
import { DefaultStorage } from "./storage";

export { InMemoryStore } from "./inMemoryStore";
export { RedisStore } from "./redisStore";
export { createStorage } from "./storage";

export interface PluginStorageFactory {
  getPluginStorage(plugin: Plugin): PluginStorage;
}

// Idea is we could have multiple implementations backed by different types of storage
// i.e. RedisStorage, PostgresStorage, MemoryStorage etc.
export interface Storage extends PluginStorageFactory {
  getNextWorkflow(
    plugins: Plugin[]
  ): Promise<null | { plugin: Plugin; workflow: Workflow }>;
  completeWorkflow(workflowId: WorkflowId): Promise<void>;
  requeueWorkflow(workflow: Workflow): Promise<void>;
  handleStorageStartupConfig(plugins: Plugin[]): Promise<void>;
}

export interface PluginStorage {
  readonly plugin: Plugin;
  getStagingArea(): Promise<StagingArea>;
  saveStagingArea(update: StagingArea): Promise<void>;
  addWorkflow(data: Object): Promise<void>;
}

/*
 * Store - backing database
 */

export interface Store {
  kv<V>(prefix?: string): KVStore<V>;
  queue<Q>(prefix?: string): QueueStore<Q>;
}

export interface KVStore<V> {
  entries(): Promise<AsyncIterable<{ field: string; value: V }>>;
  keys(): Promise<AsyncIterable<string>>;
  set(key: string, value: V): Promise<void>;
  get(key: string): Promise<V | undefined>;
  delete(key: string): Promise<void>;
  compareAndSwap(
    key: string,
    expectedValue: V | undefined,
    newValue: V
  ): Promise<boolean>;
}

export interface QueueStore<T> {
  push(value: T): Promise<void>;
  pop(): Promise<T | undefined>;
  length(): Promise<number>;
}
