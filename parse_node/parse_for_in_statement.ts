import ts, { SyntaxKind } from "typescript";
import { ParseState, combine } from "../parse_node";

import { ParseNodeType } from "../parse_node"
import { Test } from "../test";

export const parseForInStatement = (node: ts.ForInStatement, props: ParseState): ParseNodeType => {
  if (node.initializer.kind === SyntaxKind.VariableDeclarationList) {
    const vdl = node.initializer as ts.VariableDeclarationList;

    if (vdl.declarations.length > 1 || vdl.declarations.length === 0) {
      throw new Error("non-1 length of declarations in for...in");
    }

    return combine({
      parent: node,
      nodes: [vdl.declarations[0].name, node.expression, node.statement],
      props,
      addIndent: true,
      content: (name, expr, statement) => `
for ${name} in ${expr}:
  ${statement}
` });
  } else {
    const initExpr = node.initializer as ts.Expression;

    return combine({
      parent: node,
      nodes: [initExpr, node.expression, node.statement],
      props,
      addIndent: true,
      content: (initExpr, expr, statement) => `
for ${initExpr} in ${expr}:
  ${statement}
` });
  }
}

export const testForIn1: Test = {
  ts: `
for (let x in []);
  `,
  expected: `
for x in []:
  pass
  `,
};

export const testForIn2: Test = {
  ts: `
let x: never;
for (x in []);
  `,
  expected: `
var x
for x in []:
  pass
  `,
};