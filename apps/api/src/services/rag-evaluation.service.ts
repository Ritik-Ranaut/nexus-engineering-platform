export interface RagEvaluationCase {
  question: string;
  relevantFiles: string[];
  expectedFacts: string[];
  answerable: boolean;
}

export interface RagEvaluationResult {
  retrievalRelevance: number;
  answerCorrectness: number;
  citationCorrectness: number;
  hallucinationDetected: boolean;
}

export const evaluateRagCase = (
  evaluation: RagEvaluationCase,
  result: { retrievedFiles: string[]; answer: string; citedFiles: string[] }
): RagEvaluationResult => {
  const retrieved = new Set(result.retrievedFiles);
  const retrievalRelevance = evaluation.relevantFiles.length === 0
    ? Number(result.retrievedFiles.length === 0)
    : evaluation.relevantFiles.filter((file) => retrieved.has(file)).length /
      evaluation.relevantFiles.length;
  const normalizedAnswer = result.answer.toLowerCase();
  const answerCorrectness = evaluation.answerable
    ? evaluation.expectedFacts.length === 0 ? 0
      : evaluation.expectedFacts.filter((fact) => normalizedAnswer.includes(fact.toLowerCase())).length /
        evaluation.expectedFacts.length
    : Number(/not (?:available|provided|found|determined)|insufficient|cannot determine/i.test(result.answer));
  const citationCorrectness = result.citedFiles.length === 0
    ? Number(!evaluation.answerable)
    : result.citedFiles.filter((file) =>
      retrieved.has(file) && evaluation.relevantFiles.includes(file)
    ).length / result.citedFiles.length;
  const hallucinationDetected = result.citedFiles.some((file) =>
    !retrieved.has(file) || !evaluation.relevantFiles.includes(file)
  ) || (!evaluation.answerable && result.citedFiles.length > 0);
  return { retrievalRelevance, answerCorrectness, citationCorrectness, hallucinationDetected };
};
