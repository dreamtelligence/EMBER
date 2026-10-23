// Blind pairwise comparison of two eval-prose labels. Each scene is judged twice with
// the versions swapped; a version only wins a scene when both verdicts agree.
//
// npm run eval:compare -- --a baseline --b step2 [--judge claude-opus-5-5]
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

type EvalSceneResult = {
  sceneId: string;
  sceneTitle: string;
  sceneSummary: string;
  previousSceneEnding: string;
  mode: string;
  text: string;
  words: number;
  qualityScore: number | null;
};

const verdictSchema = z.object({
  winner: z.enum(["A", "B", "tie"]),
  reasons: z.array(z.string()).max(4)
});

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.a || !args.b) {
    throw new Error("--a and --b labels are required.");
  }

  const judgeModel = args.judge ?? "claude-opus-5-5";
  const evalRoot = path.join(process.cwd(), "outputs", "eval");
  const resultsA = await loadLabel(evalRoot, args.a);
  const resultsB = await loadLabel(evalRoot, args.b);
  const sceneIds = Array.from(resultsA.keys()).filter(function (sceneId) {
    return resultsB.has(sceneId);
  });

  if (!sceneIds.length) {
    throw new Error("The two labels share no scenes.");
  }

  const client = new Anthropic();
  const rows: string[] = [];
  const report: string[] = [];
  let winsA = 0;
  let winsB = 0;
  let ties = 0;

  for (const sceneId of sceneIds) {
    const a = resultsA.get(sceneId) as EvalSceneResult;
    const b = resultsB.get(sceneId) as EvalSceneResult;
    const first = await judge(client, judgeModel, a, a.text, b.text);
    const second = await judge(client, judgeModel, a, b.text, a.text);
    // Map the swapped verdict back to the real labels.
    const secondWinner = second.winner === "A" ? "B" : second.winner === "B" ? "A" : "tie";
    const outcome = first.winner === secondWinner ? first.winner : "tie";

    if (outcome === "A") winsA += 1;
    else if (outcome === "B") winsB += 1;
    else ties += 1;

    const outcomeLabel = outcome === "A" ? args.a : outcome === "B" ? args.b : "unentschieden";
    rows.push(`| ${a.sceneTitle} | ${a.words} / ${b.words} | ${a.qualityScore ?? "-"} / ${b.qualityScore ?? "-"} | ${outcomeLabel} |`);
    report.push(
      `## ${a.sceneTitle}`,
      "",
      `**Ergebnis:** ${outcomeLabel} (Durchgang 1: ${first.winner}, Durchgang 2 getauscht: ${second.winner})`,
      "",
      `**Begründung Durchgang 1:** ${first.reasons.join(" · ")}`,
      "",
      `**Begründung Durchgang 2:** ${second.reasons.join(" · ")}`,
      "",
      `### ${args.a}`,
      "",
      a.text,
      "",
      `### ${args.b}`,
      "",
      b.text,
      ""
    );
    console.log(`${a.sceneTitle}: ${outcomeLabel}`);
  }

  const outputFile = path.join(evalRoot, `compare-${args.a}-vs-${args.b}.md`);
  await writeFile(
    outputFile,
    [
      `# ${args.a} gegen ${args.b}`,
      "",
      `Gutachter: ${judgeModel}, jede Szene zweimal mit getauschter Reihenfolge; Sieg nur bei zwei gleichen Urteilen.`,
      "",
      `**${args.a}: ${winsA} · ${args.b}: ${winsB} · unentschieden: ${ties}**`,
      "",
      `| Szene | Wörter ${args.a} / ${args.b} | Note ${args.a} / ${args.b} | Sieger |`,
      "|---|---|---|---|",
      ...rows,
      "",
      ...report
    ].join("\n")
  );

  console.log(`\n${args.a}: ${winsA} · ${args.b}: ${winsB} · unentschieden: ${ties}`);
  console.log(`Bericht: ${outputFile}`);
}

async function judge(client: Anthropic, judgeModel: string, scene: EvalSceneResult, textA: string, textB: string) {
  const message = await client.messages.parse({
    model: judgeModel,
    max_tokens: 16000,
    output_config: {
      effort: "high",
      format: zodOutputFormat(verdictSchema)
    },
    system: [
      "Du bist Lektorin für deutschsprachige Unterhaltungsliteratur.",
      "Du vergleichst zwei Fassungen derselben Szene und entscheidest, welche ein Verlag eher drucken würde.",
      "Kriterien: lebendige, konkrete Prosa; Szenenbewegung und Druck; glaubwürdige Figuren; Stimme und Übergang passend zum Ende der Vorszene; Treue zur Szenenzusammenfassung; keine erklärende, glatte oder formelhafte Sprache.",
      "Länge allein ist kein Vorteil. Wähle \"tie\" nur, wenn du wirklich keinen Unterschied in der Qualität siehst.",
      "Begründungen: höchstens vier, je ein kurzer Satz."
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: [
          `<scene_title>${scene.sceneTitle}</scene_title>`,
          `<scene_summary>${scene.sceneSummary}</scene_summary>`,
          `<previous_scene_ending>${scene.previousSceneEnding}</previous_scene_ending>`,
          `<version_a>${textA}</version_a>`,
          `<version_b>${textB}</version_b>`
        ].join("\n")
      }
    ]
  });

  if (message.stop_reason === "refusal" || !message.parsed_output) {
    return { winner: "tie" as const, reasons: [`Kein Urteil (stop_reason: ${message.stop_reason}).`] };
  }

  return message.parsed_output;
}

async function loadLabel(evalRoot: string, label: string) {
  const directory = path.join(evalRoot, label);
  const files = (await readdir(directory)).filter(function (file) {
    return file.endsWith(".json");
  });
  const results = new Map<string, EvalSceneResult>();

  for (const file of files) {
    const result = JSON.parse(await readFile(path.join(directory, file), "utf8")) as EvalSceneResult;

    if (result.mode === "remote") {
      results.set(result.sceneId, result);
    }
  }

  return results;
}

function parseArgs(values: string[]) {
  const parsed: Record<string, string> = {};

  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];

    if (key.startsWith("--") && values[index + 1] !== undefined) {
      parsed[key.slice(2)] = values[index + 1];
      index += 1;
    }
  }

  return parsed as { a?: string; b?: string; judge?: string };
}
