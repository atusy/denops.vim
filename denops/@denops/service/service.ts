import {
  ensureArray,
  ensureString,
  Session,
  WorkerReader,
  WorkerWriter,
} from "../deps.ts";
import { Host, Invoker } from "./host/mod.ts";

const workerScript = "./worker/script.ts";

/**
 * Service manage plugins and is visible from the host (Vim/Neovim) through `invoke()` function.
 */
export class Service implements Invoker {
  #plugins: Record<string, { worker: Worker; plugin: Session }>;
  #host: Host;

  constructor(host: Host) {
    this.#plugins = {};
    this.#host = host;
  }

  register(name: string, script: string): void {
    if (name in this.#plugins) {
      const { worker } = this.#plugins[name];
      worker.terminate();
    }
    const worker = new Worker(
      new URL(workerScript, import.meta.url).href,
      {
        name,
        type: "module",
        deno: {
          namespace: true,
        },
      },
    );
    worker.postMessage({ name, script });
    const reader = new WorkerReader(worker);
    const writer = new WorkerWriter(worker);
    const plugin = new Session(reader, writer, {
      dispatch: async (name, fn, ...args) => {
        ensureString(name);
        ensureString(fn);
        ensureArray(args);
        return await this.dispatch(name, fn, args);
      },

      call: async (fn, ...args) => {
        ensureString(fn);
        ensureArray(args);
        return await this.#host.call(fn, ...args);
      },
    });
    this.#plugins[name] = {
      plugin,
      worker,
    };
  }

  async dispatch(name: string, fn: string, args: unknown[]): Promise<unknown> {
    try {
      const { plugin } = this.#plugins[name];
      if (!plugin) {
        throw new Error(`No plugin '${name}' is registered`);
      }
      return await plugin.call(fn, ...args);
    } catch (e) {
      // NOTE:
      // Vim/Neovim does not handle JavaScript Error instance thus use string instead
      throw `${e.stack ?? e.toString()}`;
    }
  }

  dispatchAsync(
    name: string,
    fn: string,
    args: unknown[],
    success: string, // Callback ID
    failure: string, // Callback ID
  ): Promise<void> {
    this.dispatch(name, fn, args)
      .then((r) => this.#host.call("denops#callback#call", success, r))
      .catch((e) => this.#host.call("denops#callback#call", failure, e))
      .catch((e) => {
        console.error(`${e.stack ?? e.toString()}`);
      });
    return Promise.resolve();
  }
}
