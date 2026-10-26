// The slice of dockerode (and tar-stream) the bundled security_scan module calls. dockerode ships
// no types of its own; this declares exactly what scanRunner.service.js uses, so a call outside it
// is a type error rather than a silent `any`. Extend it when the module needs more.
// Ambient on purpose (no top-level import/export), so the declarations apply to `require('dockerode')`.

declare module 'dockerode' {
  import type { Readable, Writable } from 'node:stream';

  namespace Docker {
    /** One line of a pull or build progress stream. */
    interface ProgressEvent {
      status?: string;
      id?: string;
      stream?: string;
      error?: string;
    }

    interface Modem {
      followProgress(
        stream: Readable,
        onFinished: (err: Error | null, output: ProgressEvent[]) => void,
        onProgress?: (event: ProgressEvent) => void,
      ): void;
      /** Split a multiplexed docker log/exec stream into stdout and stderr. */
      demuxStream(stream: Readable, stdout: Writable, stderr: Writable): void;
    }

    interface Image {
      inspect(): Promise<unknown>;
      tag(options: { repo: string; tag: string }): Promise<unknown>;
    }

    interface Network {
      inspect(): Promise<unknown>;
      connect(options: { Container: string }): Promise<unknown>;
    }

    interface HostConfig {
      Memory?: number;
      NanoCpus?: number;
      PidsLimit?: number;
      Init?: boolean;
      AutoRemove?: boolean;
      SecurityOpt?: string[];
      RestartPolicy?: { Name: string };
      Binds?: string[];
      NetworkMode?: string;
      PortBindings?: Record<string, { HostIp: string; HostPort: string }[]>;
      CapDrop?: string[];
      CapAdd?: string[];
    }

    interface ContainerCreateOptions {
      name?: string;
      Image: string;
      Cmd?: string[];
      Env?: string[];
      User?: string;
      Labels?: Record<string, string>;
      ExposedPorts?: Record<string, object>;
      NetworkingConfig?: { EndpointsConfig: Record<string, object> };
      HostConfig?: HostConfig;
    }

    interface ContainerInspectInfo {
      NetworkSettings?: { Ports?: Record<string, { HostPort?: string }[] | null> };
    }

    interface ExecCreateOptions {
      Cmd: string[];
      AttachStdout?: boolean;
      AttachStderr?: boolean;
      Tty?: boolean;
    }

    interface Exec {
      /** The attached, still multiplexed stream. */
      start(options: { hijack?: boolean; stdin?: boolean }): Promise<Readable>;
      inspect(): Promise<{ ExitCode?: number | null }>;
    }

    interface Container {
      id: string;
      modem: Modem;
      start(): Promise<unknown>;
      stop(options?: { t?: number }): Promise<unknown>;
      kill(): Promise<unknown>;
      remove(options?: { force?: boolean }): Promise<unknown>;
      wait(): Promise<{ StatusCode?: number }>;
      inspect(): Promise<ContainerInspectInfo>;
      logs(
        options: { follow: true; stdout: boolean; stderr: boolean },
        callback: (err: Error | null, stream?: Readable) => void,
      ): void;
      exec(options: ExecCreateOptions): Promise<Exec>;
    }

    interface ContainerInfo {
      Id: string;
      State?: string;
      Labels?: Record<string, string>;
    }
  }

  class Docker {
    constructor(options?: { socketPath?: string });
    modem: Docker.Modem;
    ping(): Promise<unknown>;
    getImage(name: string): Docker.Image;
    pull(image: string, callback: (err: Error | null, stream: Readable) => void): void;
    buildImage(context: Readable, options: { t: string; dockerfile: string }): Promise<Readable>;
    getNetwork(id: string): Docker.Network;
    createNetwork(options: { Name: string; Driver: string }): Promise<Docker.Network>;
    getContainer(id: string): Docker.Container;
    createContainer(options: Docker.ContainerCreateOptions): Promise<Docker.Container>;
    listContainers(options: { all?: boolean; filters?: Record<string, string[]> }): Promise<Docker.ContainerInfo[]>;
  }

  export = Docker;
}

declare module 'tar-stream' {
  import type { Readable } from 'node:stream';

  interface Pack extends Readable {
    entry(header: { name: string }, data: Buffer | string): void;
    finalize(): void;
  }

  export function pack(): Pack;
}
