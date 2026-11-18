import { describe, expect, it } from "vitest";
import evaluation from "./fixtures/rag-evaluation.json";
import { evaluateRagCase } from "../src/services/rag-evaluation.service.js";

describe("RAG evaluation fixture", () => {
  it("measures retrieval, answer, citation correctness, and unsupported-answer behavior", () => {
    const results = evaluation.cases.map((testCase, index) => {
      if (index === 0) {
        return evaluateRagCase(testCase, {
          retrievedFiles: ["src/auth.ts"],
          citedFiles: ["src/auth.ts"],
          answer: "verifyToken checks the JWT signature and rejects expired tokens."
        });
      }
      if (index === 1) {
        return evaluateRagCase(testCase, {
          retrievedFiles: ["src/orders.ts"],
          citedFiles: ["src/orders.ts", "src/missing.ts"],
          answer: "OrderRepository stores order records."
        });
      }
      return evaluateRagCase(testCase, {
        retrievedFiles: [],
        citedFiles: [],
        answer: "This information is not available in the indexed repository."
      });
    });

    expect(results[0]).toEqual({
      retrievalRelevance: 1,
      answerCorrectness: 1,
      citationCorrectness: 1,
      hallucinationDetected: false
    });
    expect(results[1]).toMatchObject({
      retrievalRelevance: 1,
      answerCorrectness: 1,
      citationCorrectness: 0.5,
      hallucinationDetected: true
    });
    expect(results[2]).toEqual({
      retrievalRelevance: 1,
      answerCorrectness: 1,
      citationCorrectness: 1,
      hallucinationDetected: false
    });
    console.info("RAG fixture metrics", {
      cases: results.length,
      meanRetrievalRelevance: results.reduce((sum, item) => sum + item.retrievalRelevance, 0) / results.length,
      meanAnswerCorrectness: results.reduce((sum, item) => sum + item.answerCorrectness, 0) / results.length,
      meanCitationCorrectness: results.reduce((sum, item) => sum + item.citationCorrectness, 0) / results.length,
      hallucinationCases: results.filter((item) => item.hallucinationDetected).length
    });
  });
});
