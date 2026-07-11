import { CreateConceptRequestSchema, LinkConceptsRequestSchema } from "../models/schemas.js";

export interface ResolverSchemaResult {
  shape: string;
  known: boolean;
  envelope?: string;
  fields?: Array<{ name: string; required: boolean; type: string }>;
  required?: string[];
  invocation?: string;
}

const CONTRACTS: Record<string, { envelope: string; schema: unknown }> = {
  concept_create_write: { envelope: "conceptData", schema: CreateConceptRequestSchema },
  conceptLink_write: { envelope: "linkData", schema: LinkConceptsRequestSchema },
};

export function resolveResolverSchema(pointer: { type: "resolver_schema"; shape: string }): ResolverSchemaResult {
  const c = CONTRACTS[pointer.shape];
  if (!c) return { shape: pointer.shape, known: false };
  let fields: Array<{ name: string; required: boolean; type: string }> = [];
  try {
    const shp = (c.schema as any).shape as Record<string, unknown>;
    fields = Object.entries(shp).map(([name, f]) => {
      const field = f as any;
      let required = true;
      try { required = typeof field.isOptional === "function" ? !field.isOptional() : true; } catch { required = true; }
      return { name, required, type: (field?._def?.typeName as string | undefined) ?? "unknown" };
    });
  } catch { fields = []; }
  return {
    shape: pointer.shape,
    known: true,
    envelope: c.envelope,
    fields,
    required: fields.filter((f) => f.required).map((f) => f.name),
    invocation: `pointer:{type:"${pointer.shape}", ${c.envelope}:{...}}`,
  };
}
