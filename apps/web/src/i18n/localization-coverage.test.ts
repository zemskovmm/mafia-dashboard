import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");
const hostTextAttributes = new Set([
  "aria-label",
  "aria-description",
  "placeholder",
  "title",
  "alt",
]);
const timelineTextProperties = new Set(["label", "ariaLabel", "accessibleLabel"]);
const allowedText = new Set(["K", "Q", "YouTube", "YouTube Music", "La Verdad"]);

const productionTsx = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionTsx(path);
    return entry.isFile() && path.endsWith(".tsx") && !path.endsWith(".test.tsx") ? [path] : [];
  });

const hasWords = (value: string): boolean => /\p{L}{2}/u.test(value.trim());

const templateText = (expression: ts.TemplateExpression): string =>
  `${expression.head.text}${expression.templateSpans.map((span) => span.literal.text).join("")}`;

const renderedLiterals = (expression: ts.Expression): ts.Expression[] => {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return hasWords(expression.text) && !allowedText.has(expression.text) ? [expression] : [];
  }
  if (ts.isTemplateExpression(expression))
    return hasWords(templateText(expression)) ? [expression] : [];
  if (ts.isParenthesizedExpression(expression)) return renderedLiterals(expression.expression);
  if (ts.isConditionalExpression(expression)) {
    return [...renderedLiterals(expression.whenTrue), ...renderedLiterals(expression.whenFalse)];
  }
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return [...renderedLiterals(expression.left), ...renderedLiterals(expression.right)];
  }
  return [];
};

const location = (source: ts.SourceFile, node: ts.Node): string => {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${relative(sourceRoot, source.fileName)}:${line + 1}:${character + 1}`;
};

describe("localization coverage", () => {
  it("routes host-facing JSX text, accessible attributes, and confirmations through catalogs", () => {
    const failures: string[] = [];
    const files = [
      ...productionTsx(sourceRoot),
      join(sourceRoot, "features", "timeline", "timeline-model.ts"),
    ];
    for (const file of files) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const inspect = (node: ts.Node) => {
        if (ts.isJsxText(node)) {
          const text = node.getText(source).replace(/\s+/g, " ").trim();
          if (hasWords(text) && !allowedText.has(text)) {
            failures.push(`${location(source, node)} raw JSX text: ${JSON.stringify(text)}`);
          }
        }
        if (
          ts.isJsxAttribute(node) &&
          hostTextAttributes.has(node.name.getText(source)) &&
          node.initializer !== undefined &&
          ts.isStringLiteral(node.initializer) &&
          hasWords(node.initializer.text) &&
          !(node.name.getText(source) === "alt" && node.initializer.text === "")
        ) {
          failures.push(
            `${location(source, node)} raw ${node.name.getText(source)}: ${JSON.stringify(node.initializer.text)}`,
          );
        }
        if (
          ts.isJsxAttribute(node) &&
          hostTextAttributes.has(node.name.getText(source)) &&
          node.initializer !== undefined &&
          ts.isJsxExpression(node.initializer) &&
          node.initializer.expression !== undefined
        ) {
          for (const literal of renderedLiterals(node.initializer.expression)) {
            failures.push(
              `${location(source, literal)} raw ${node.name.getText(source)} expression: ${JSON.stringify(literal.getText(source))}`,
            );
          }
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.expression.getText(source) === "window" &&
          node.expression.name.text === "confirm"
        ) {
          const argument = node.arguments[0];
          if (
            argument !== undefined &&
            (ts.isStringLiteral(argument) ||
              ts.isNoSubstitutionTemplateLiteral(argument) ||
              ts.isTemplateExpression(argument))
          ) {
            failures.push(`${location(source, argument)} raw window.confirm text`);
          }
        }
        if (
          ts.isJsxExpression(node) &&
          node.expression !== undefined &&
          (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
        ) {
          for (const literal of renderedLiterals(node.expression)) {
            failures.push(
              `${location(source, literal)} raw rendered expression: ${JSON.stringify(literal.getText(source))}`,
            );
          }
        }
        if (
          ts.isPropertyAssignment(node) &&
          timelineTextProperties.has(node.name.getText(source)) &&
          ts.isExpression(node.initializer) &&
          renderedLiterals(node.initializer).length > 0
        ) {
          failures.push(
            `${location(source, node.initializer)} raw timeline ${node.name.getText(source)}`,
          );
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    }

    expect(failures, failures.join("\n")).toEqual([]);
  });
});
