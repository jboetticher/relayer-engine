import { Mutex } from "async-mutex";
import { createClient } from "redis";
import { KVStore, QueueStore, Store } from ".";
import { getScopedLogger } from "../helpers/logHelper";
import { nnull } from "../utils/utils";

const logger = () => getScopedLogger(["redisHelper"]);

export interface RedisEnv {
  redisPort?: number;
  redisHost?: string;
}

// TODO
interface RedisConnectionConfig {}

type RedisClientType = Awaited<ReturnType<typeof createConnection>>;
let rClient: RedisClientType | null;

export class RedisStore implements Store {
  kvs: Map<string, RedisKV<any>>;
  queues: Map<string, RedisQueue<any>>;

  static async create(redisEnv: RedisEnv) {
    if (!redisEnv.redisHost || !redisEnv.redisPort) {
      throw new Error("Cannot connect to redis without host and port")
    }
    const client = await createConnection(redisEnv);
    return new RedisStore(redisEnv, client);
  }

  private constructor(
    readonly redisEnv: RedisEnv,
    readonly client: RedisClientType
  ) {
    this.kvs = new Map();
    this.queues = new Map();
  }

  kv<V>(prefix: string = "__defaultKV"): KVStore<V> {
    let kv = this.kvs.get(prefix);
    if (!kv) {
      kv = new RedisKV(prefix, this.client);
      this.kvs.set(prefix, kv);
    }
    return kv;
  }
  queue<Q>(prefix: string = "__defaultQueue"): QueueStore<Q> {
    let queue = this.queues.get(prefix);
    if (!queue) {
      queue = new RedisQueue(prefix, this.client);
      this.queues.set(prefix, queue);
    }
    return queue;
  }
}

class RedisKV<V> implements KVStore<V> {
  constructor(readonly prefix: string, readonly client: RedisClientType) {}

  async keys(): Promise<AsyncIterable<string>> {
    const iter = this.client.hScanIterator(this.prefix);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const { field, value } of iter) {
          yield field;
        }
      },
    };
  }

  async entries(): Promise<AsyncIterable<{ field: string; value: V }>> {
    const iter = this.client.hScanIterator(this.prefix);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const { field, value } of iter) {
          yield { field, value: JSON.parse(value) };
        }
      },
    };
  }

  set(key: string, value: V): Promise<void> {
    return enqueueOp(() =>
      this.client.hSet(this.prefix, key, JSON.stringify(value))
    );
  }

  async get(key: string): Promise<V | undefined> {
    const res = await this.client.hGet(this.prefix, key);
    if (res) {
      return JSON.parse(res);
    }
  }

  async delete(key: string): Promise<void> {
    await enqueueOp(() => this.client.hDel(this.prefix, key));
  }

  compareAndSwap(
    key: string,
    expectedValue: V | undefined,
    newValue: V
  ): Promise<boolean> {
    // directly use the mutex since this command requires a return value
    // and should not be retried
    return mutex.runExclusive(async () => {
      try {
        const client = this.client;
        const itemInRedis = await client.hGet(this.prefix, key);
        if (
          expectedValue &&
          (!itemInRedis || JSON.parse(itemInRedis) !== expectedValue)
        ) {
          logger().info("Compare and swap failed");
          return false;
        }
        await client.hSet(this.prefix, key, JSON.stringify(newValue));
        return true;
      } catch (e) {
        logger().error("Failed compare and swap");
        logger().error(e);
        return false;
      }
    });
  }
}

class RedisQueue<Q> implements QueueStore<Q> {
  constructor(readonly prefix: string, readonly client: RedisClientType) {}
  push(value: Q): Promise<void> {
    return enqueueOp(() =>
      this.client.lPush(this.prefix, JSON.stringify(value))
    );
  }
  pop(): Promise<Q | undefined> {
    return mutex.runExclusive(() =>
      this.client.rPop(this.prefix).then((x) => (x ? JSON.parse(x) : x))
    );
  }
  length(): Promise<number> {
    return this.client.lLen(this.prefix)
  }
}

let backlog: (() => Promise<void>)[] = [];
let mutex = new Mutex();

async function enqueueOp<Arg extends any>(
  op: (...args: Arg[]) => Promise<any>
) {
  backlog.push(op);
  await executeBacklog();
}

// This process executes the backlog periodically, so that items inside the backlog
// do not need to wait for a new item to enter the backlog before they can execute again
setInterval(executeBacklog, 1000 * 60);

export async function executeBacklog(): Promise<void> {
  await mutex.runExclusive(async () => {
    for (let i = 0; i < backlog.length; ++i) {
      try {
        await backlog[i]();
      } catch (e) {
        backlog = backlog.slice(i);
        logger().error(e);
        return;
      }
    }
    backlog = [];
  });
}

async function createConnection({ redisPort, redisHost }: RedisEnv) {
  try {
    let client = createClient({
      socket: {
        host: redisHost,
        port: redisPort,
      },
    });

    client.on("connect", function (err) {
      if (err) {
        logger().error(
          "connectToRedis: failed to connect to host [" +
            redisHost +
            "], port [" +
            redisPort +
            "]: %o",
          err
        );
      }
    });

    await client.connect();
    rClient = client;
    return nnull(client);
  } catch (e) {
    logger().error(
      "connectToRedis: failed to connect to host [" +
        redisHost +
        "], port [" +
        redisPort +
        "]: %o",
      e
    );
    throw new Error("Could not connect to Redis");
  }
}

/*
async function insertItemToHashMap(
  mapKey: string,
  fieldKey: string,
  value: string
): Promise<boolean> {
  try {
    logger().debug(
      `Inserting into redis hash set: ${mapKey}, key: ${fieldKey}, value: ${value}`
    );
    const client = await getClient();
    client.hSet(mapKey, fieldKey, value);
    logger().debug(`Done inserting key: ${fieldKey} into ${mapKey}`);
    return true;
  } catch (e) {
    logger().error(
      `Failed inserting into redis hash set: ${mapKey}, key: ${fieldKey}, value: ${value}`
    );
    return false;
  }
}
*/

//The backlog is a FIFO queue of outstanding redis operations

