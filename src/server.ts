import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ExtendClient,
  ExtendEnvironment,
  ExtendError,
  PollingTimeoutError,
} from "extend-ai";
import { createReadStream, existsSync } from "node:fs";
import { resolve } from "node:path";

// ===================================================================
// Public config interface
// ===================================================================

export interface ServerConfig {
  apiKey: string;
  environment?: string; // "us" | "us2" | "eu"
  baseUrl?: string; // override API base URL (e.g. https://api.staging.extend.ai)
  tools?: string; // comma-separated groups or "all"
  disableFilePath?: boolean;
}

export const ALL_TOOL_GROUPS = ["parse", "extract", "classify", "split", "edit", "files"] as const;
export type ToolGroup = (typeof ALL_TOOL_GROUPS)[number];

// ===================================================================
// createServer
// ===================================================================

export function createServer(config: ServerConfig): McpServer {
  // --- Resolve base URL ---
  const ENV_MAP: Record<string, string> = {
    us: ExtendEnvironment.Production,
    us2: ExtendEnvironment.ProductionUs2,
    eu: ExtendEnvironment.ProductionEu1,
  };

  let clientOptions: { token: string; environment?: string; baseUrl?: string };
  if (config.baseUrl) {
    clientOptions = { token: config.apiKey, baseUrl: config.baseUrl };
  } else {
    const envName = (config.environment || "us").toLowerCase();
    const environment = ENV_MAP[envName];
    if (!environment) {
      throw new Error(`Invalid environment "${envName}". Must be one of: us, us2, eu`);
    }
    clientOptions = { token: config.apiKey, environment };
  }

  // --- Resolve tool groups ---
  const enabledGroups: Set<ToolGroup> = (() => {
    const raw = (config.tools || "all").toLowerCase().trim();
    if (raw === "all" || raw === "") return new Set(ALL_TOOL_GROUPS);
    const requested = raw.split(",").map((s) => s.trim()) as ToolGroup[];
    const invalid = requested.filter(
      (g) => !(ALL_TOOL_GROUPS as readonly string[]).includes(g),
    );
    if (invalid.length) {
      throw new Error(
        `Invalid tool groups: ${invalid.join(", ")}. Valid groups: ${ALL_TOOL_GROUPS.join(", ")}`,
      );
    }
    return new Set(requested);
  })();

  const allowFilePath = !config.disableFilePath;

  // --- Extend client ---
  const client = new ExtendClient(clientOptions);

  // --- Helpers ---
  const POLL_TIMEOUT_MS = 600_000; // 10 minutes

  const filePathParam: Record<string, z.ZodTypeAny> = allowFilePath
    ? { file_path: z.string().optional().describe("Absolute path to a file on the user's machine. Only use this when the user provides an explicit file path. NEVER guess or fabricate paths like /home/claude/.") }
    : {};

  async function uploadLocalFile(filePath: string): Promise<{ id: string }> {
    const abs = resolve(filePath);
    if (!existsSync(abs)) {
      throw new Error(`File not found: ${abs}`);
    }
    const uploaded = await client.files.upload(createReadStream(abs));
    return { id: uploaded.id };
  }

  async function fileInput(params: {
    file_url?: string;
    file_id?: string;
    file_text?: string;
    file_path?: string;
  }): Promise<{ url: string } | { id: string } | { text: string }> {
    if (params.file_path) {
      if (!allowFilePath)
        throw new Error(
          "file_path is disabled on this server — use file_url or file_id instead",
        );
      return uploadLocalFile(params.file_path);
    }
    if (params.file_url) return { url: params.file_url };
    if (params.file_id) return { id: params.file_id };
    if (params.file_text) return { text: params.file_text };
    throw new Error("Provide one of: file_path, file_url, file_id, or file_text");
  }

  function ok(data: unknown) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }

  function err(error: unknown) {
    let detail: Record<string, unknown>;
    if (error instanceof PollingTimeoutError) {
      detail = {
        error: "polling_timeout",
        message: `Processing did not complete within ${POLL_TIMEOUT_MS / 1000}s. The run may still be processing — use the run ID to check status later.`,
      };
    } else if (error instanceof ExtendError) {
      detail = {
        error: "extend_api_error",
        statusCode: error.statusCode,
        message: error.message,
        body: error.body,
      };
    } else if (error instanceof Error) {
      detail = { error: "unexpected_error", message: error.message };
    } else {
      detail = { error: "unexpected_error", message: String(error) };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(detail, null, 2) }],
      isError: true,
    };
  }

  function tryParseJson(s: string | undefined): Record<string, unknown> | undefined {
    if (!s) return undefined;
    try {
      return JSON.parse(s);
    } catch {
      throw new Error(`Invalid JSON in config parameter: ${s}`);
    }
  }

  // --- Server ---
  const server = new McpServer({
    name: "extend",
    version: "0.1.0",
  });

  // -----------------------------------------------------------------
  // Parse
  // -----------------------------------------------------------------

  if (enabledGroups.has("parse")) {
    server.tool(
      "parse_document",
      "Parse a document into structured markdown chunks. Supports PDF, Word, PowerPoint, images, and more. Returns cleaned text content ideal for RAG pipelines or downstream processing.",
      {
        ...filePathParam,
        file_url: z.string().url().optional().describe("Public URL of the document"),
        file_id: z.string().optional().describe("Extend file ID (starts with file_)"),
      },
      async (params) => {
        try {
          const result = await client.parseRuns.createAndPoll(
            { file: (await fileInput(params)) as any },
            { maxWaitMs: POLL_TIMEOUT_MS },
          );
          return ok(result);
        } catch (error) {
          return err(error);
        }
      },
    );
  }

  // -----------------------------------------------------------------
  // Extract
  // -----------------------------------------------------------------

  if (enabledGroups.has("extract")) {
    server.tool(
      "extract_data",
      `Extract structured data from a document. Use extractor_id to reference a pre-configured extractor, or pass an inline config with a JSON schema defining the fields to extract. Returns the extracted key-value pairs.

IMPORTANT: If you already have the document text in the conversation (e.g. the user pasted it or uploaded a file you can read), use file_text — do NOT use file_path. Only use file_path when the user gives you an explicit path on their machine.

When building an inline config schema, follow these rules:
- Root must be: {"type":"object","properties":{...},"required":[...]}
- ALL scalar property types MUST be nullable: use ["string","null"], ["number","null"], ["integer","null"], or ["boolean","null"] — never bare "string" etc.
- Arrays use "type":"array" (not nullable) with NON-nullable items: {"type":"array","items":{"type":"string"}} or items can be a nested object
- Enums: {"enum":["val1","val2",null]} — always include null in the array
- Nested objects: {"type":"object","properties":{...},"required":[...]}
- Each property can have a "description" field to guide extraction
- Extend-specific: use "extend:type":"date" on string fields for date extraction (returns ISO yyyy-mm-dd)
- NOT supported: $ref, oneOf, anyOf, allOf, pattern, format, minLength, etc.`,
      {
        ...filePathParam,
        file_url: z.string().url().optional().describe("Public URL of the document"),
        file_id: z.string().optional().describe("Extend file ID (starts with file_)"),
        file_text: z
          .string()
          .optional()
          .describe("Raw text content to extract from (instead of a file)"),
        extractor_id: z
          .string()
          .optional()
          .describe("ID of a pre-configured extractor (starts with ex_)"),
        config: z
          .string()
          .optional()
          .describe(
            'Inline extraction config as JSON string. Example: {"schema":{"type":"object","properties":{"invoice_number":{"type":["string","null"],"description":"The invoice number"},"total":{"type":["number","null"],"description":"Total amount"},"date":{"type":["string","null"],"extend:type":"date","description":"Invoice date"}},"required":["invoice_number","total","date"]}}',
          ),
      },
      async (params) => {
        try {
          const request: Record<string, unknown> = {
            file: await fileInput(params),
          };
          if (params.extractor_id) {
            request.extractor = { id: params.extractor_id };
          }
          if (params.config) {
            request.config = tryParseJson(params.config);
          }
          const result = await client.extractRuns.createAndPoll(request as any, {
            maxWaitMs: POLL_TIMEOUT_MS,
          });
          return ok(result);
        } catch (error) {
          return err(error);
        }
      },
    );

    server.tool(
      "list_extractors",
      "List available extractors configured in your Extend account. Returns extractor IDs and names that can be used with extract_data.",
      {
        next_page_token: z
          .string()
          .optional()
          .describe("Pagination token from a previous response"),
        max_page_size: z.number().optional().describe("Maximum number of results to return"),
      },
      async (params) => {
        try {
          const result = await client.extractors.list({
            nextPageToken: params.next_page_token,
            maxPageSize: params.max_page_size,
          });
          return ok(result);
        } catch (error) {
          return err(error);
        }
      },
    );

    server.tool(
      "get_extractor",
      "Get details of a specific extractor, including its field schema and configuration.",
      {
        extractor_id: z.string().describe("Extractor ID (starts with ex_)"),
      },
      async (params) => {
        try {
          const result = await client.extractors.retrieve(params.extractor_id);
          return ok(result);
        } catch (error) {
          return err(error);
        }
      },
    );
  }

  // -----------------------------------------------------------------
  // Classify
  // -----------------------------------------------------------------

  if (enabledGroups.has("classify")) {
    server.tool(
      "classify_document",
      `Classify a document into one of several categories. Use classifier_id to reference a pre-configured classifier, or pass an inline config with classification definitions.

When building an inline config, each classification entry requires exactly three fields: id (unique, lowercase_underscore), type (string identifier), and description (detailed explanation). Do NOT include a "name" field. At least one entry MUST have type "other" as a catch-all.`,
      {
        ...filePathParam,
        file_url: z.string().url().optional().describe("Public URL of the document"),
        file_id: z.string().optional().describe("Extend file ID (starts with file_)"),
        file_text: z
          .string()
          .optional()
          .describe("Raw text content to classify (instead of a file)"),
        classifier_id: z
          .string()
          .optional()
          .describe("ID of a pre-configured classifier (starts with cls_)"),
        config: z
          .string()
          .optional()
          .describe(
            'Inline classification config as JSON string. Each entry needs id, type, and description. One entry must have type "other". Example: {"classifications":[{"id":"invoice","type":"invoice","description":"An invoice for goods or services"},{"id":"receipt","type":"receipt","description":"A purchase receipt"},{"id":"other","type":"other","description":"Any other document type"}]}',
          ),
      },
      async (params) => {
        try {
          const request: Record<string, unknown> = {
            file: await fileInput(params),
          };
          if (params.classifier_id) {
            request.classifier = { id: params.classifier_id };
          }
          if (params.config) {
            request.config = tryParseJson(params.config);
          }
          const result = await client.classifyRuns.createAndPoll(request as any, {
            maxWaitMs: POLL_TIMEOUT_MS,
          });
          return ok(result);
        } catch (error) {
          return err(error);
        }
      },
    );

    server.tool(
      "list_classifiers",
      "List available classifiers configured in your Extend account. Returns classifier IDs and names that can be used with classify_document.",
      {
        next_page_token: z
          .string()
          .optional()
          .describe("Pagination token from a previous response"),
        max_page_size: z.number().optional().describe("Maximum number of results to return"),
      },
      async (params) => {
        try {
          const result = await client.classifiers.list({
            nextPageToken: params.next_page_token,
            maxPageSize: params.max_page_size,
          });
          return ok(result);
        } catch (error) {
          return err(error);
        }
      },
    );

    server.tool(
      "get_classifier",
      "Get details of a specific classifier, including its document type definitions.",
      {
        classifier_id: z.string().describe("Classifier ID (starts with cls_)"),
      },
      async (params) => {
        try {
          const result = await client.classifiers.retrieve(params.classifier_id);
          return ok(result);
        } catch (error) {
          return err(error);
        }
      },
    );
  }

  // -----------------------------------------------------------------
  // Split
  // -----------------------------------------------------------------

  if (enabledGroups.has("split")) {
    server.tool(
      "split_document",
      `Split a multi-document file into separate documents. Use splitter_id to reference a pre-configured splitter, or pass an inline config defining the document types to split by.

When building an inline config, each splitClassification entry requires exactly three fields: id (unique, lowercase_underscore), type (string identifier), and description (detailed explanation). Do NOT include a "name" field. At least one entry MUST have type "other" as a catch-all.`,
      {
        ...filePathParam,
        file_url: z.string().url().optional().describe("Public URL of the document"),
        file_id: z.string().optional().describe("Extend file ID (starts with file_)"),
        splitter_id: z
          .string()
          .optional()
          .describe("ID of a pre-configured splitter (starts with spl_)"),
        config: z
          .string()
          .optional()
          .describe(
            'Inline split config as JSON string. Each entry needs id, type, and description. One entry must have type "other". Example: {"splitClassifications":[{"id":"invoice","type":"invoice","description":"An invoice document"},{"id":"receipt","type":"receipt","description":"A receipt document"},{"id":"other","type":"other","description":"Any other document type"}]}',
          ),
      },
      async (params) => {
        try {
          const request: Record<string, unknown> = {
            file: await fileInput(params),
          };
          if (params.splitter_id) {
            request.splitter = { id: params.splitter_id };
          }
          if (params.config) {
            request.config = tryParseJson(params.config);
          }
          const result = await client.splitRuns.createAndPoll(request as any, {
            maxWaitMs: POLL_TIMEOUT_MS,
          });
          return ok(result);
        } catch (error) {
          return err(error);
        }
      },
    );

    server.tool(
      "list_splitters",
      "List available splitters configured in your Extend account. Returns splitter IDs and names that can be used with split_document.",
      {
        next_page_token: z
          .string()
          .optional()
          .describe("Pagination token from a previous response"),
        max_page_size: z.number().optional().describe("Maximum number of results to return"),
      },
      async (params) => {
        try {
          const result = await client.splitters.list({
            nextPageToken: params.next_page_token,
            maxPageSize: params.max_page_size,
          });
          return ok(result);
        } catch (error) {
          return err(error);
        }
      },
    );

    server.tool(
      "get_splitter",
      "Get details of a specific splitter, including its document type definitions.",
      {
        splitter_id: z.string().describe("Splitter ID (starts with spl_)"),
      },
      async (params) => {
        try {
          const result = await client.splitters.retrieve(params.splitter_id);
          return ok(result);
        } catch (error) {
          return err(error);
        }
      },
    );
  }

  // -----------------------------------------------------------------
  // Edit
  // -----------------------------------------------------------------

  if (enabledGroups.has("edit")) {
    server.tool(
      "edit_document",
      "Edit a PDF document — detect and fill form fields using natural language instructions or explicit field values. Returns the edited PDF file URL.",
      {
        ...filePathParam,
        file_url: z.string().url().optional().describe("Public URL of the PDF"),
        file_id: z.string().optional().describe("Extend file ID (starts with file_)"),
        instructions: z
          .string()
          .optional()
          .describe(
            "Natural language instructions for filling the form (e.g. 'Fill applicant name as Jane Doe')",
          ),
        config: z
          .string()
          .optional()
          .describe("Edit config as JSON string for field-level control"),
      },
      async (params) => {
        try {
          const request: Record<string, unknown> = {
            file: await fileInput(params),
          };
          if (params.instructions) {
            request.config = { instructions: params.instructions };
          } else if (params.config) {
            request.config = tryParseJson(params.config);
          }
          const result = await client.editRuns.createAndPoll(request as any, {
            maxWaitMs: POLL_TIMEOUT_MS,
          });
          return ok(result);
        } catch (error) {
          return err(error);
        }
      },
    );
  }

  // -----------------------------------------------------------------
  // Files
  // -----------------------------------------------------------------

  if (enabledGroups.has("files")) {
    if (allowFilePath) {
      server.tool(
        "upload_file",
        "Upload a local file to Extend. Returns the file ID which can be used with other tools.",
        {
          file_path: z.string().describe("Local file path on disk"),
        },
        async (params) => {
          try {
            const abs = resolve(params.file_path);
            if (!existsSync(abs)) {
              throw new Error(`File not found: ${abs}`);
            }
            const result = await client.files.upload(createReadStream(abs));
            return ok(result);
          } catch (error) {
            return err(error);
          }
        },
      );
    }

    server.tool(
      "list_files",
      "List files in your Extend account. Optionally filter by name.",
      {
        name_contains: z
          .string()
          .optional()
          .describe("Filter files whose name contains this string"),
        next_page_token: z
          .string()
          .optional()
          .describe("Pagination token from a previous response"),
        max_page_size: z.number().optional().describe("Maximum number of results to return"),
      },
      async (params) => {
        try {
          const result = await client.files.list({
            nameContains: params.name_contains,
            nextPageToken: params.next_page_token,
            maxPageSize: params.max_page_size,
          });
          return ok(result);
        } catch (error) {
          return err(error);
        }
      },
    );

    server.tool(
      "get_file",
      "Get details and metadata for a specific file in Extend.",
      {
        file_id: z.string().describe("File ID (starts with file_)"),
      },
      async (params) => {
        try {
          const result = await client.files.retrieve(params.file_id);
          return ok(result);
        } catch (error) {
          return err(error);
        }
      },
    );
  }

  return server;
}
