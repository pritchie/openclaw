import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../plugin-sdk/signal.js", () => ({
  probeSignal: vi.fn(),
}));

import { probeSignal } from "../plugin-sdk/signal.js";
import { runCommandWithTimeout, type SpawnResult } from "../process/exec.js";
import { note } from "../terminal/note.js";
import { noteSignalCliVersionHealth } from "./doctor-install.js";

function spawnResult(partial: Partial<SpawnResult>): SpawnResult {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    signal: null,
    killed: false,
    termination: "exit",
    ...partial,
  };
}

function signalProbe(
  partial: Partial<Awaited<ReturnType<typeof probeSignal>>>,
): Awaited<ReturnType<typeof probeSignal>> {
  return {
    ok: true,
    status: 200,
    error: null,
    elapsedMs: 0,
    version: null,
    ...partial,
  };
}

describe("doctor install notes", () => {
  const noteSpy = vi.mocked(note);
  const probeSignalMock = vi.mocked(probeSignal);
  const runCommandWithTimeoutMock = vi.mocked(runCommandWithTimeout);

  beforeEach(() => {
    noteSpy.mockClear();
    probeSignalMock.mockReset();
    runCommandWithTimeoutMock.mockReset();
  });

  it("warns from the daemon version for workspace-local auto-start installs", async () => {
    probeSignalMock.mockResolvedValue(
      signalProbe({
        ok: true,
        version: "0.13.12",
      }),
    );

    await noteSignalCliVersionHealth("/home/openclaw/projects/openclaw", {
      channels: {
        signal: {
          cliPath: "/home/openclaw/projects/openclaw/build/install/signal-cli/bin/signal-cli",
        },
      },
    });

    expect(probeSignalMock).toHaveBeenCalledWith("http://127.0.0.1:8080", 10_000);
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("Signal daemon 0.13.12 at http://127.0.0.1:8080"),
      "Install",
    );
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("workspace-local build"),
      "Install",
    );
  });

  it("falls back to the local CLI with managed-install guidance when the daemon probe fails", async () => {
    probeSignalMock.mockResolvedValue(
      signalProbe({
        ok: false,
        error: "connect ECONNREFUSED",
      }),
    );
    runCommandWithTimeoutMock.mockResolvedValue(
      spawnResult({
        code: 0,
        stdout: "signal-cli 0.13.10\n",
      }),
    );

    await noteSignalCliVersionHealth("/home/openclaw/projects/openclaw", {
      channels: {
        signal: {
          cliPath: "/home/openclaw/.openclaw/tools/signal-cli/0.13.10/bin/signal-cli",
        },
      },
    });

    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      ["/home/openclaw/.openclaw/tools/signal-cli/0.13.10/bin/signal-cli", "--version"],
      expect.any(Object),
    );
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not verify the running daemon"),
      "Install",
    );
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("OpenClaw-managed install"),
      "Install",
    );
  });

  it("checks account-level Signal CLI paths when the top-level path is unset", async () => {
    probeSignalMock.mockResolvedValue(
      signalProbe({
        ok: false,
        error: "connect ECONNREFUSED",
      }),
    );
    runCommandWithTimeoutMock.mockResolvedValue(
      spawnResult({
        code: 0,
        stdout: "signal-cli 0.13.12\n",
      }),
    );

    await noteSignalCliVersionHealth("/home/openclaw/projects/openclaw", {
      channels: {
        signal: {
          accounts: {
            work: {
              cliPath: "/opt/openclaw/work-signal/bin/signal-cli",
            },
          },
        },
      },
    });

    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      ["/opt/openclaw/work-signal/bin/signal-cli", "--version"],
      expect.any(Object),
    );
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("channels.signal.accounts.work.cliPath"),
      "Install",
    );
  });

  it('checks the implicit "signal-cli" fallback when Signal uses local auto-start', async () => {
    probeSignalMock.mockResolvedValue(
      signalProbe({
        ok: false,
        error: "connect ECONNREFUSED",
      }),
    );
    runCommandWithTimeoutMock.mockResolvedValue(
      spawnResult({
        code: 0,
        stdout: "signal-cli 0.13.12\n",
      }),
    );

    await noteSignalCliVersionHealth("/home/openclaw/projects/openclaw", {
      channels: {
        signal: {
          account: "+15550001111",
        },
      },
    });

    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      ["signal-cli", "--version"],
      expect.any(Object),
    );
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining('channels.signal.cliPath (default "signal-cli")'),
      "Install",
    );
    expect(noteSpy).toHaveBeenCalledWith(expect.stringContaining("system install"), "Install");
  });

  it("checks the remote daemon version and skips the local CLI when auto-start is off", async () => {
    probeSignalMock.mockResolvedValue(
      signalProbe({
        ok: true,
        version: "0.13.12",
      }),
    );

    await noteSignalCliVersionHealth("/home/openclaw/projects/openclaw", {
      channels: {
        signal: {
          httpUrl: "http://gateway-host:8080",
          cliPath: "/usr/local/bin/signal-cli",
          autoStart: false,
        },
      },
    });

    expect(probeSignalMock).toHaveBeenCalledWith("http://gateway-host:8080", 10_000);
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("Signal daemon 0.13.12 at http://gateway-host:8080"),
      "Install",
    );
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("existing Signal daemon"),
      "Install",
    );
  });

  it("notes when a remote daemon version cannot be verified and skips the local CLI", async () => {
    probeSignalMock.mockResolvedValue(
      signalProbe({
        ok: false,
        error: "connect ECONNREFUSED",
      }),
    );

    await noteSignalCliVersionHealth("/home/openclaw/projects/openclaw", {
      channels: {
        signal: {
          httpUrl: "http://gateway-host:8080",
        },
      },
    });

    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "could not verify the Signal daemon version at http://gateway-host:8080",
      ),
      "Install",
    );
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("confirm it is running signal-cli 0.13.14 or newer"),
      "Install",
    );
  });

  it("stays quiet when the daemon meets the minimum version", async () => {
    probeSignalMock.mockResolvedValue(
      signalProbe({
        ok: true,
        version: "0.13.14",
      }),
    );

    await noteSignalCliVersionHealth("/home/openclaw/projects/openclaw", {
      channels: {
        signal: {
          cliPath: "/usr/local/bin/signal-cli",
        },
      },
    });

    expect(noteSpy).not.toHaveBeenCalled();
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("warns when doctor cannot read the local CLI version after the daemon probe fails", async () => {
    probeSignalMock.mockResolvedValue(
      signalProbe({
        ok: false,
        error: "connect ECONNREFUSED",
      }),
    );
    runCommandWithTimeoutMock.mockResolvedValue(
      spawnResult({ code: 1, stdout: "", stderr: "boom" }),
    );

    await noteSignalCliVersionHealth("/home/openclaw/projects/openclaw", {
      channels: {
        signal: {
          cliPath: "/usr/local/bin/signal-cli",
        },
      },
    });

    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("doctor could not verify the Signal version for account default"),
      "Install",
    );
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("last daemon probe error: connect ECONNREFUSED"),
      "Install",
    );
  });
});
