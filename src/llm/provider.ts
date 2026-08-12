export interface WorkExtractionInput {
  projectName: string;
  sessions: Array<{ title: string; evidence: string[] }>;
}

export interface WorkExtractionResult {
  title: string;
  summary: string;
  status: string;
  nextStep?: string;
  evidenceIds: string[];
}

export interface WorklogModelProvider {
  readonly name: string;
  extractWorkItems(input: WorkExtractionInput): Promise<WorkExtractionResult[]>;
}

// The prototype intentionally keeps model extraction behind this interface.
// Scanning, evidence browsing and deterministic status inference work offline.
