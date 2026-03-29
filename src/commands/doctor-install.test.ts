import { beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../terminal/note.js";

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

import { runCommandWithTimeout, type SpawnResult } from "../process/exec.js";
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

describe("doctor install notes", () => {
  const noteSpy = vi.mocked(note);
  const runCommandWithTimeoutMock = vi.mocked(runCommandWithTimeout);

  beforeEach(() => {
    noteSpy.mockClear();
    runCommandWithTimeoutMock.mockReset();
  });

  it("warns when configured workspace Signal CLI is below minimum version", async () => {
    runCommandWithTimeoutMock.mockResolvedValue(
      spawnResult({
        code: 0,
        stdout: "signal-cli 0.13.12\n",
        stderr: "",
      }),
    );

    await noteSignalCliVersionHealth("/home/openclaw/projects/openclaw", {
      channels: {
        signal: {
          cliPath: "/home/openclaw/projects/openclaw/build/install/signal-cli/bin/signal-cli",
        },
      },
    });

    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("below the minimum supported version 0.13.14"),
      "Install",
    );
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("workspace-local build"),
      "Install",
    );
  });

  it("warns with managed-install guidance for OpenClaw-managed signal-cli", async () => {
    runCommandWithTimeoutMock.mockResolvedValue(
      spawnResult({
        code: 0,
        stdout: "signal-cli 0.13.10\n",
        stderr: "",
      }),
    );

    await noteSignalCliVersionHealth("/home/openclaw/projects/openclaw", {
      channels: {
        signal: {
          cliPath: "/home/openclaw/.openclaw/tools/signal-cli/0.13.10/bin/signal-cli",
        },
      },
    });

    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("OpenClaw-managed install"),
      "Install",
    );
  });

  it("stays quiet when signal-cli meets the minimum version", async () => {
    runCommandWithTimeoutMock.mockResolvedValue(
      spawnResult({
        code: 0,
        stdout: "signal-cli 0.13.14\n",
        stderr: "",
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
  });

  it("warns when doctor cannot read signal-cli version", async () => {
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
      expect.stringContaining("doctor could not read its version"),
      "Install",
    );
  });
});
