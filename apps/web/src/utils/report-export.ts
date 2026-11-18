import type { EngineeringReport } from "../api/client";

const severityOrder = ["critical", "high", "medium", "low", "suggestion"] as const;
const severityLabels: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  suggestion: "Suggestion"
};
const categoryLabels: Record<string, string> = {
  security: "Security",
  code_quality: "Code quality",
  performance: "Performance",
  testing: "Testing",
  documentation: "Documentation"
};

export const reportToMarkdown = (report: EngineeringReport) => {
  const findings = report.findings ?? [];
  const confirmed = findings.filter((finding) => finding.verification === "confirmed");
  const unverified = findings.filter((finding) => finding.verification === "unverified");
  const lines = [
    `# ${report.title}`,
    "",
    `- **Status:** ${report.status}`,
    `- **Generated:** ${new Date(report.createdAt).toLocaleString()}`,
    `- **Type:** ${report.reportType.replaceAll("_", " ")}`,
    ...(report.missionId ? [`- **Mission:** ${report.missionId}`] : []),
    `- **Index generation:** ${report.generation.indexedGeneration}`,
    "",
    "## Executive summary",
    "",
    report.summary,
    "",
    "> Evidence validation confirms that quoted text and line ranges match the active indexed source; it does not independently prove a finding's interpretation or severity.",
    "",
    "## Severity breakdown",
    "",
    ...severityOrder.map((severity) => `- ${severityLabels[severity]}: ${report.severityCounts[severity] ?? 0}`),
    "",
    "## Category breakdown",
    "",
    ...Object.entries(report.categoryCounts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, count]) => `- ${categoryLabels[category] ?? category}: ${count ?? 0}`),
    "",
    "## Health score",
    "",
    report.healthScore.status === "calculated"
      ? `${report.healthScore.value}/100`
      : "Insufficient data",
    report.healthScore.formula,
    report.healthScore.rationale,
    "",
    "## Confirmed findings",
    "",
    ...confirmed.flatMap((finding) => [
      `### [${severityLabels[finding.severity] ?? finding.severity}] ${finding.title}`,
      "",
      `${categoryLabels[finding.category] ?? finding.category} · ${Math.round(finding.confidence * 100)}% confidence`,
      "",
      finding.description,
      "",
      `**Recommendation:** ${finding.recommendation}`,
      "",
      ...finding.evidence.flatMap((evidence) => [
        `- \`${evidence.filePath}:${evidence.startLine}-${evidence.endLine}\` — ${evidence.explanation}`,
        "",
        ...evidence.quote.split(/\r?\n/).map((line) => `> ${line}`),
        ""
      ]),
      ""
    ]),
    ...(unverified.length > 0 ? ["## Unverified suggestions", "", ...unverified.flatMap((finding) => [
      `- **${finding.title}** (${categoryLabels[finding.category] ?? finding.category}): ${finding.description}`,
      ...finding.affectedFiles.map((filePath) => `  - Unverified file reference: \`${filePath}\``)
    ]), ""] : []),
    "## Prioritized actions",
    "",
    ...(report.recommendations.length > 0
      ? report.recommendations.flatMap((recommendation) => [
        `- **${severityLabels[recommendation.severity] ?? recommendation.severity}: ${recommendation.title}** — ${recommendation.action}`,
        ...recommendation.affectedFiles.map((filePath) => `  - \`${filePath}\``)
      ])
      : ["None"]),
    "",
    "## Affected files",
    "",
    ...(report.affectedFiles.length > 0
      ? report.affectedFiles.map((file) => `- \`${file.filePath}\` (${file.findingIds.length} finding(s))`)
      : ["None"]),
    "",
    "## Limitations",
    "",
    ...(report.limitations.length > 0 ? report.limitations.map((limitation) => `- ${limitation}`) : ["None recorded"]),
    ""
  ];
  return lines.join("\n");
};

export const reportToJson = (report: EngineeringReport) => JSON.stringify(report, null, 2);
