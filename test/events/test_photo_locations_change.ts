import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initPhotoLocationsChangePublisher, publishPhotoLocationsChanged } from "../../server/events/photo-locations-change.js";
import { PUBSUB_CHANNELS } from "../../src/config/pubsubChannels.js";
import type { IPubSub } from "../../server/events/pub-sub/index.js";
import { WORKSPACE_PATHS } from "../../server/workspace/paths.js";
import { saveSettings } from "../../server/system/config.js";

interface Published {
  channel: string;
  data: unknown;
}

function fakePubSub(sink: Published[]): IPubSub {
  return {
    publish: (channel, data) => sink.push({ channel, data }),
  } as IPubSub;
}

describe("photo-locations change publisher", () => {
  // The module holds a singleton; each test re-wires it explicitly.
  beforeEach(() => {
    // Rewire to a no-op so a prior test's fake instance can't leak.
    initPhotoLocationsChangePublisher(fakePubSub([]));
  });

  it("publishes to the locations-changed channel once wired", () => {
    const sink: Published[] = [];
    initPhotoLocationsChangePublisher(fakePubSub(sink));
    publishPhotoLocationsChanged();
    assert.equal(sink.length, 1);
    const [published] = sink;
    assert.ok(published);
    assert.equal(published.channel, PUBSUB_CHANNELS.locationsChanged);
  });

  it("publishes on the exact channel the plugin META declares", () => {
    assert.equal(PUBSUB_CHANNELS.locationsChanged, "photoLocations:locations-changed");
  });

  it("does not throw when the underlying publish throws (fire-and-forget)", () => {
    initPhotoLocationsChangePublisher({
      publish: () => {
        throw new Error("socket down");
      },
    } as IPubSub);
    assert.doesNotThrow(() => publishPhotoLocationsChanged());
  });
});

// Integration: a successful sidecar write must fire the publisher, so an open
// View refetches. This is the end-to-end behavior; the unit tests above only
// prove the publisher itself works.
describe("photo-locations change publisher — write-path integration", () => {
  const FAKE_GPS_EXIF = { latitude: 35.6586, longitude: 139.7454, Make: "Apple", DateTimeOriginal: "2024:05:11 10:23:45" };
  let savedDescriptors: Record<string, PropertyDescriptor>;
  let workspaceRoot: string;

  function overrideWorkspacePath(key: string, value: string): void {
    const desc = Object.getOwnPropertyDescriptor(WORKSPACE_PATHS, key);
    if (desc) savedDescriptors[key] = desc;
    Object.defineProperty(WORKSPACE_PATHS, key, { value, configurable: true, enumerable: true, writable: true });
  }

  beforeEach(() => {
    savedDescriptors = {};
    workspaceRoot = mkdtempSync(path.join(tmpdir(), "photo-loc-pub-"));
    overrideWorkspacePath("attachments", path.join(workspaceRoot, "data/attachments"));
    overrideWorkspacePath("locations", path.join(workspaceRoot, "data/locations"));
    overrideWorkspacePath("configs", path.join(workspaceRoot, "config"));
  });

  afterEach(() => {
    for (const [key, desc] of Object.entries(savedDescriptors)) {
      Object.defineProperty(WORKSPACE_PATHS, key, desc);
    }
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("fires the publisher after a sidecar is written", async () => {
    saveSettings({ extraAllowedTools: [] });
    const sink: Published[] = [];
    initPhotoLocationsChangePublisher(fakePubSub(sink));
    // The capture reads the real file at absPath before handing bytes to the
    // (stubbed) parser, so it must exist on disk.
    const photoPath = path.join(workspaceRoot, "pic.jpg");
    writeFileSync(photoPath, Buffer.from("not-a-real-jpeg"));
    const { capturePhotoLocationWithParser } = await import("../../server/workspace/photo-locations/index.js");
    await capturePhotoLocationWithParser(photoPath, "data/attachments/2026/07/pic.jpg", "image/jpeg", () => Promise.resolve(FAKE_GPS_EXIF));
    assert.equal(sink.length, 1, "a sidecar write should publish exactly one change event");
    const [published] = sink;
    assert.ok(published);
    assert.equal(published.channel, PUBSUB_CHANNELS.locationsChanged);
  });
});
