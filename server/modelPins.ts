import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ModelPin {
  providerID: string;
  modelID: string;
}

export const MODEL_PINS_MAX = 20;
export const DEFAULT_MODEL_PINS: ModelPin[] = [
  { providerID: "openai", modelID: "gpt-5.6-sol" },
  { providerID: "anthropic", modelID: "claude-opus-4-6" },
];

export class ModelPinError extends Error {}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;
}

export function normalizeModelPins(value: unknown): ModelPin[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { models?: unknown }).models)) {
    throw new ModelPinError("models must be an array of model references");
  }
  const models = (value as { models: unknown[] }).models;
  if (models.length > MODEL_PINS_MAX) throw new ModelPinError(`models must contain at most ${MODEL_PINS_MAX} models`);

  const result: ModelPin[] = [];
  const seen = new Set<string>();
  for (const item of models) {
    if (!item || typeof item !== "object") throw new ModelPinError("each model pin must contain providerID and modelID");
    const providerID = identifier((item as Record<string, unknown>).providerID);
    const modelID = identifier((item as Record<string, unknown>).modelID);
    if (!providerID || !modelID) throw new ModelPinError("each model pin must contain providerID and modelID");
    const key = `${providerID}\0${modelID}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ providerID, modelID });
    }
  }
  return result;
}

export class ModelPinStore {
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(readonly file = process.env.MODEL_PINS_FILE || path.resolve(process.cwd(), ".state/model-pins.json")) {}

  async read(): Promise<ModelPin[]> {
    try {
      return normalizeModelPins(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_MODEL_PINS.map((model) => ({ ...model }));
      throw new Error("model pins could not be read");
    }
  }

  async write(value: unknown): Promise<ModelPin[]> {
    const models = normalizeModelPins(value);
    const operation = this.pendingWrite.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, models }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.pendingWrite = operation.catch(() => undefined);
    await operation;
    return models;
  }
}
