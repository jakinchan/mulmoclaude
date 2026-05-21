// Unit tests for `packages/plugins/client-plugin/src/io.ts`.
// Covers the parseYaml / deserialiseProject roundtrip — in particular
// the regression where an empty-value frontmatter key (e.g.
// `expectedDeliverables: `) used to default to `[]` and made the entire
// project record fail Zod validation, causing approved projects to
// silently vanish from `listProjects`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseYaml, deserialiseProject, deserialiseClient, serialiseProject, serialiseClient } from "../../packages/plugins/client-plugin/src/io.ts";
import type { Project, Client } from "../../packages/plugins/client-plugin/src/types.ts";

function deserialiseProjectOrFail(markdown: string, message: string): Project {
  const project = deserialiseProject(markdown);
  if (!project) {
    assert.fail(message);
  }
  return project;
}

function deserialiseClientOrFail(markdown: string, message: string): Client {
  const client = deserialiseClient(markdown);
  if (!client) {
    assert.fail(message);
  }
  return client;
}

describe("client-plugin io — parseYaml", () => {
  it("treats an empty-value key with no nested content as an empty string, not an empty array", () => {
    const yaml = ["id: design", "name: Design", "expectedDeliverables: "].join("\n");
    const meta = parseYaml(yaml);
    assert.equal(meta.id, "design");
    assert.equal(meta.name, "Design");
    assert.equal(meta.expectedDeliverables, "", "empty-value key must be '', not [] — Zod string fields reject arrays");
  });

  it("still parses nested objects when indented children follow an empty-value key", () => {
    const yaml = ["rate:", "  amount: 150", "  currency: USD", "  unit: hour"].join("\n");
    const meta = parseYaml(yaml);
    assert.deepEqual(meta.rate, { amount: "150", currency: "USD", unit: "hour" });
  });

  it("still parses arrays when indented list items follow an empty-value key", () => {
    const yaml = ["tags:", "  - vip", "  - enterprise"].join("\n");
    const meta = parseYaml(yaml);
    assert.deepEqual(meta.tags, ["vip", "enterprise"]);
  });
});

describe("client-plugin io — deserialiseProject", () => {
  it("round-trips a Project with empty expectedDeliverables/notes (regression: dashboard dropped projects)", () => {
    const markdown = [
      "---",
      "id: design",
      "clientId: acme",
      "name: Design",
      "status: active",
      "feeModel: hour",
      "rate:",
      "  amount: 150",
      "  currency: USD",
      "  unit: hour",
      "startDate: 2026-05-21",
      "expectedDeliverables: ",
      "---",
      "",
      "",
    ].join("\n");
    const project = deserialiseProjectOrFail(
      markdown,
      "project with empty expectedDeliverables must deserialise — it used to return null and silently disappear from listProjects",
    );
    assert.equal(project.id, "design");
    assert.equal(project.clientId, "acme");
    assert.equal(project.status, "active");
    assert.equal(project.feeModel, "hour");
    assert.equal(project.expectedDeliverables, "");
    assert.equal(project.notes, "");
  });

  it("round-trips serialiseProject → deserialiseProject for an empty-deliverables project", () => {
    const markdown = serialiseProject({
      id: "design",
      clientId: "acme",
      name: "Design",
      status: "active",
      feeModel: "hour",
      rate: { amount: 150, currency: "USD", unit: "hour" },
      startDate: "2026-05-21",
      expectedDeliverables: "",
      notes: "",
    });
    const project = deserialiseProjectOrFail(markdown, "round-trip must succeed");
    assert.equal(project.expectedDeliverables, "");
  });

  it("preserves non-empty deliverables and notes through the roundtrip", () => {
    const markdown = serialiseProject({
      id: "redesign",
      clientId: "acme",
      name: "Redesign",
      status: "active",
      feeModel: "fixed",
      rate: { amount: 5000, currency: "USD", unit: "fixed" },
      startDate: "2026-06-01",
      expectedDeliverables: "Sitemap, Wireframes, Figma, Live Site",
      notes: "Kickoff scheduled for June.",
    });
    const project = deserialiseProjectOrFail(markdown, "round-trip must succeed");
    assert.equal(project.expectedDeliverables, "Sitemap, Wireframes, Figma, Live Site");
    assert.equal(project.notes, "Kickoff scheduled for June.");
  });
});

describe("client-plugin io — deserialiseClient", () => {
  it("round-trips a Client whose serialised form has no contacts/tags/notes", () => {
    const markdown = serialiseClient({
      id: "acme",
      name: "Acme",
      status: "active",
      contacts: [],
      rate: { amount: 0, currency: "USD", unit: "hour" },
      paymentTerms: "net-30",
      tags: [],
      firstEngagement: "2026-05-21",
      notes: "",
    });
    const client = deserialiseClientOrFail(markdown, "round-trip must succeed");
    assert.equal(client.id, "acme");
    assert.equal(client.name, "Acme");
    assert.deepEqual(client.contacts, []);
    assert.deepEqual(client.tags, []);
    assert.equal(client.notes, "");
  });
});
