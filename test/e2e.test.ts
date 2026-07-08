import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PDFDocument, PDFTextField } from "pdf-lib";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, ALL_TOOL_GROUPS } from "../src/server.js";

// ===================================================================
// Helpers
// ===================================================================

const API_KEY = process.env.EXTEND_API_KEY;
const BASE_URL = process.env.EXTEND_BASE_URL;

/** Connect an MCP client to a server in-process via InMemoryTransport. */
async function connectClient(
  ...args: Parameters<typeof createServer>
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createServer(...args);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.1" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Parse the text content from a tool result. */
function resultJson(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
  return JSON.parse(text);
}

/** Write string content to a temp file, return its path. */
function tempFile(name: string, content: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "extend-mcp-test-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

/** Generate a simple multi-page PDF with distinct page text. */
async function makeMultiPagePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const label of ["Invoice #1001", "Receipt #2002", "Contract #3003"]) {
    const page = doc.addPage([400, 200]);
    page.drawText(label, { x: 50, y: 100, size: 24 });
  }
  return Buffer.from(await doc.save());
}

/** Generate a PDF with fillable form fields. */
async function makeFormPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  page.drawText("Application Form", { x: 50, y: 260, size: 18 });
  const form = doc.getForm();
  const nameField = form.createTextField("applicant_name");
  nameField.addToPage(page, { x: 50, y: 200, width: 200, height: 25 });
  const dateField = form.createTextField("date");
  dateField.addToPage(page, { x: 50, y: 150, width: 200, height: 25 });
  return Buffer.from(await doc.save());
}

// ===================================================================
// Tool discovery tests — no API key needed
// ===================================================================

describe("tool discovery", () => {
  it("registers all tools by default", async () => {
    const { client, close } = await connectClient({ apiKey: "fake" });
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "classify_document",
        "create_extractor",
        "edit_document",
        "extract_data",
        "generate_edit_schema",
        "get_classifier",
        "get_extractor",
        "get_file",
        "get_splitter",
        "list_classifiers",
        "list_extractors",
        "list_files",
        "list_splitters",
        "parse_document",
        "split_document",
        "upload_file",
      ]);
    } finally {
      await close();
    }
  });

  it("filters tools by EXTEND_TOOLS groups", async () => {
    const { client, close } = await connectClient({ apiKey: "fake", tools: "parse,extract" });
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "create_extractor",
        "extract_data",
        "get_extractor",
        "list_extractors",
        "parse_document",
      ]);
    } finally {
      await close();
    }
  });

  it("removes file_path params and upload_file when disableFilePath is set", async () => {
    const { client, close } = await connectClient({ apiKey: "fake", disableFilePath: true });
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).not.toContain("upload_file");

      const parseTool = tools.find((t) => t.name === "parse_document")!;
      const props = (parseTool.inputSchema as any).properties ?? {};
      expect(props).not.toHaveProperty("file_path");
      expect(props).toHaveProperty("file_url");
    } finally {
      await close();
    }
  });
});

// ===================================================================
// API tests — skipped without EXTEND_API_KEY
// ===================================================================

describe.skipIf(!API_KEY)("document processing", () => {
  let client: Client;
  let close: () => Promise<void>;
  const tempFiles: string[] = [];

  beforeAll(async () => {
    ({ client, close } = await connectClient({ apiKey: API_KEY!, baseUrl: BASE_URL }));
  });

  afterAll(async () => {
    await close();
    for (const f of tempFiles) {
      try { unlinkSync(f); } catch {}
    }
  });

  it("parse_document with file_path", async () => {
    const path = tempFile("invoice.txt", "Invoice #12345\nDate: 2025-01-15\nVendor: Acme Corp\nTotal: $1,234.56");
    tempFiles.push(path);

    const result = await client.callTool({
      name: "parse_document",
      arguments: { file_path: path },
    });
    const data = resultJson(result);
    expect(data.status, JSON.stringify(data)).toBe("PROCESSED");
    expect(data.output, JSON.stringify(data)).toBeDefined();
  });

  it("extract_data with file_text and inline config", async () => {
    const config = JSON.stringify({
      schema: {
        type: "object",
        properties: {
          invoice_number: { type: ["string", "null"], description: "The invoice number" },
          vendor: { type: ["string", "null"], description: "The vendor name" },
          total: { type: ["string", "null"], description: "The total amount" },
        },
        required: ["invoice_number", "vendor", "total"],
      },
    });

    const result = await client.callTool({
      name: "extract_data",
      arguments: {
        file_text: "Invoice #12345\nDate: 2025-01-15\nVendor: Acme Corp\nTotal: $1,234.56",
        config,
      },
    });
    const data = resultJson(result);
    expect(data.status, JSON.stringify(data)).toBe("PROCESSED");
    expect(data.output, JSON.stringify(data)).toBeDefined();
  });

  it("classify_document with file_text and inline config", async () => {
    const config = JSON.stringify({
      classifications: [
        { id: "invoice", type: "invoice", description: "An invoice for goods or services" },
        { id: "receipt", type: "receipt", description: "A purchase receipt" },
        { id: "contract", type: "contract", description: "A legal contract" },
        { id: "other", type: "other", description: "Any other document type" },
      ],
    });

    const result = await client.callTool({
      name: "classify_document",
      arguments: {
        file_text: "Invoice #12345\nDate: 2025-01-15\nVendor: Acme Corp\nTotal: $1,234.56",
        config,
      },
    });
    const data = resultJson(result);
    expect(data.status, JSON.stringify(data)).toBe("PROCESSED");
    expect(data.output, JSON.stringify(data)).toBeDefined();
    expect(data.output.type, JSON.stringify(data)).toBe("invoice");
  });

  it("split_document with generated multi-page PDF", async () => {
    const pdfBytes = await makeMultiPagePdf();
    const path = tempFile("multi.pdf", pdfBytes);
    tempFiles.push(path);

    const config = JSON.stringify({
      splitClassifications: [
        { id: "invoice", type: "invoice", description: "An invoice document" },
        { id: "receipt", type: "receipt", description: "A receipt document" },
        { id: "contract", type: "contract", description: "A contract document" },
        { id: "other", type: "other", description: "Any other document type" },
      ],
    });

    const result = await client.callTool({
      name: "split_document",
      arguments: { file_path: path, config },
    });
    const data = resultJson(result);
    expect(data.status, JSON.stringify(data)).toBe("PROCESSED");
    expect(data.output, JSON.stringify(data)).toBeDefined();
    expect(data.output.splits.length, JSON.stringify(data)).toBeGreaterThan(0);
  });

  it("edit_document with generated form PDF", async () => {
    const pdfBytes = await makeFormPdf();
    const path = tempFile("form.pdf", pdfBytes);
    tempFiles.push(path);

    const result = await client.callTool({
      name: "edit_document",
      arguments: {
        file_path: path,
        instructions: "Fill applicant_name with 'Jane Doe' and date with '2025-01-15'",
      },
    });
    const data = resultJson(result);
    expect(data.status, JSON.stringify(data)).toBe("PROCESSED");
    expect(data.output, JSON.stringify(data)).toBeDefined();
  });

  it("returns structured error for missing file input", async () => {
    const result = await client.callTool({
      name: "extract_data",
      arguments: { config: '{"schema":{"type":"object","properties":{}}}' },
    });
    expect(result.isError).toBe(true);
    const data = resultJson(result);
    expect(data.error).toBeDefined();
  });
});

describe.skipIf(!API_KEY)("config discovery", () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ client, close } = await connectClient({ apiKey: API_KEY!, baseUrl: BASE_URL }));
  });

  afterAll(async () => {
    await close();
  });

  it("list_extractors returns list structure", async () => {
    const result = await client.callTool({
      name: "list_extractors",
      arguments: {},
    });
    const data = resultJson(result);
    expect(data.object, JSON.stringify(data)).toBe("list");
    expect(Array.isArray(data.data), JSON.stringify(data)).toBe(true);
  });

  it("list_classifiers returns list structure", async () => {
    const result = await client.callTool({
      name: "list_classifiers",
      arguments: {},
    });
    const data = resultJson(result);
    expect(data.object, JSON.stringify(data)).toBe("list");
    expect(Array.isArray(data.data), JSON.stringify(data)).toBe(true);
  });

  it("list_splitters returns list structure", async () => {
    const result = await client.callTool({
      name: "list_splitters",
      arguments: {},
    });
    const data = resultJson(result);
    expect(Array.isArray(data.data), JSON.stringify(data)).toBe(true);
  });
});

describe.skipIf(!API_KEY)("file management", () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ client, close } = await connectClient({ apiKey: API_KEY!, baseUrl: BASE_URL }));
  });

  afterAll(async () => {
    await close();
  });

  it("upload_file + get_file roundtrip", async () => {
    const path = tempFile("test-upload.txt", "Hello from extend-mcp e2e test");

    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { file_path: path },
    });
    const uploaded = resultJson(uploadResult);
    expect(uploaded.id, JSON.stringify(uploaded)).toMatch(/^file_/);

    const getResult = await client.callTool({
      name: "get_file",
      arguments: { file_id: uploaded.id },
    });
    const file = resultJson(getResult);
    expect(file.id, JSON.stringify(file)).toBe(uploaded.id);

    try { unlinkSync(path); } catch {}
  });

  it("list_files returns list structure", async () => {
    const result = await client.callTool({
      name: "list_files",
      arguments: {},
    });
    const data = resultJson(result);
    expect(data.object, JSON.stringify(data)).toBe("list");
    expect(Array.isArray(data.data), JSON.stringify(data)).toBe(true);
  });
});
