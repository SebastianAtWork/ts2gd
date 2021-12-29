import ts, { SyntaxKind } from "typescript"

import { ErrorName } from "../project"
import { ParseNodeType, ParseState, combine, parseNode } from "../parse_node"
import { Test } from "../tests/test"
import { mockProjectPath } from "../tests/test_utils"

import { LibraryFunctions } from "./library_functions"

/**
 * The class_name and extends statements *must* come first in the file, so we
 * preprocess the class to find them prior to our normal pass.
 */
const getClassDeclarationHeader = (
  node: ts.ClassDeclaration | ts.ClassExpression,
  props: ParseState
) => {
  // TODO: Can be moved into parse_class_declaration i think

  let extendsFrom = ""

  if (node.heritageClauses) {
    // TODO: Ensure there's only one of each here

    const clause = node.heritageClauses[0] as ts.HeritageClause
    const type = clause.types[0]

    extendsFrom = type.getText()
  }

  const isTool = !!node.decorators?.find(
    (dec) => dec.expression.getText() === "tool"
  )

  return `${isTool ? "tool\n" : ""}${
    extendsFrom ? `extends ${extendsFrom}` : ""
  }
${props.isAutoload ? "" : `class_name ${node.name?.getText()}\n`}`
}

export const getFileHeader = (): string => {
  return `# This file has been autogenerated by ts2gd. DO NOT EDIT!\n\n`
}

export const parseSourceFile = (
  node: ts.SourceFile,
  props: ParseState
): ParseNodeType => {
  const { statements } = node
  const sourceInfo = props.project
    .sourceFiles()
    .find((file) => file.fsPath === node.fileName)

  // props.usages = utils.collectVariableUsage(node)
  props.isAutoload = sourceInfo?.isAutoload() ?? false

  const allClasses = statements.filter(
    (statement) =>
      statement.kind === SyntaxKind.ClassDeclaration &&
      // skip class type declarations
      (statement.modifiers ?? []).filter((m) => m.getText() === "declare")
        .length === 0
  ) as ts.ClassDeclaration[]

  if (allClasses.length === 0) {
    props.project.errors.add({
      error: ErrorName.ClassNameNotFound,
      location: node,
      description:
        "Every file must have one class in it, but this file doesn't have any.",
      stack: new Error().stack ?? "",
    })
  }

  const parsedClassDeclarations: {
    fileName: string
    parsedClass: ParseNodeType
    classDecl: ts.ClassDeclaration | ts.ClassExpression
  }[] = []
  let hoistedLibraryFunctionDefinitions = ""
  let hoistedEnumImports = ""
  let hoistedArrowFunctions = ""

  /**
   * These are almost always an error - it's invalid to write let x = 5 outside of
   * a method scope in ts2gd. However, we use them for two reasons.
   *
   * 1. They make test writing a heck of a lot more convenient - no need to wrap
   * everything in a class
   * 2. They are used to declare the autoload global variable.
   */
  let toplevelStatements: ts.Statement[] = []

  const files: { filePath: string; body: string }[] = []

  for (const statement of statements) {
    if (
      statement.kind !== SyntaxKind.ClassDeclaration &&
      statement.kind !== SyntaxKind.ClassExpression
    ) {
      toplevelStatements.push(statement)

      continue
    }

    const parsedStatement = parseNode(statement, props)

    if (!statement.modifiers?.map((m) => m.getText()).includes("declare")) {
      // TODO: Push this logic into class declaration and expression classes

      const classDecl = statement as ts.ClassDeclaration | ts.ClassExpression
      const className = classDecl.name?.text

      if (!className) {
        props.project.errors.add({
          description: "Anonymous classes are not supported",
          error: ErrorName.ClassCannotBeAnonymous,
          location: classDecl,
          stack: new Error().stack ?? "",
        })

        continue
      }

      parsedClassDeclarations.push({
        fileName: props.sourceFileAsset.gdPath,
        parsedClass: parsedStatement,
        classDecl,
      })
    }

    for (const lf of parsedStatement.hoistedLibraryFunctions ?? []) {
      hoistedLibraryFunctionDefinitions +=
        LibraryFunctions[lf].definition("__" + LibraryFunctions[lf].name) + "\n"
    }

    for (const af of parsedStatement.hoistedArrowFunctions ?? []) {
      hoistedArrowFunctions += af.content + "\n"
    }

    for (const fi of parsedStatement.files ?? []) {
      files.push(fi)
    }
  }

  const codegenToplevelStatements =
    toplevelStatements.length > 0
      ? combine({
          nodes: toplevelStatements,
          parent: toplevelStatements[0].parent,
          props,
          parsedStrings: (...strs) => strs.join("\n"),
        })
      : undefined

  for (const lf of codegenToplevelStatements?.hoistedLibraryFunctions ?? []) {
    hoistedLibraryFunctionDefinitions +=
      LibraryFunctions[lf].definition("__" + LibraryFunctions[lf].name) + "\n"
  }

  for (const af of codegenToplevelStatements?.hoistedArrowFunctions ?? []) {
    hoistedArrowFunctions += af.content + "\n"
  }

  for (const fi of codegenToplevelStatements?.files ?? []) {
    files.push(fi)
  }

  for (const { fileName, parsedClass, classDecl } of parsedClassDeclarations) {
    files.push({
      filePath: fileName,
      body: `
${getFileHeader()}
${getClassDeclarationHeader(classDecl, props)}    
${hoistedEnumImports}
${hoistedLibraryFunctionDefinitions}
${hoistedArrowFunctions}
${codegenToplevelStatements?.content ?? ""}
${parsedClass.content}`,
    })
  }

  if (parsedClassDeclarations.length === 0) {
    // Generate SOME code - even though it'll certainly be wrong

    files.push({
      filePath: node.getSourceFile().fileName.slice(0, -".ts".length),
      body: `
${getFileHeader()}
${hoistedEnumImports}
${hoistedLibraryFunctionDefinitions}
${hoistedArrowFunctions}
${codegenToplevelStatements?.content ?? ""}`,
    })
  }

  return {
    files,
    content: "",
  }
}

export const testToolAnnotation: Test = {
  ts: `
@tool
export class Test {
}
  `,
  expected: `
tool
class_name Test
`,
}

export const testTwoClasses: Test = {
  ts: `
export class Test1 { }
export class Test2 { }
  `,
  expected: {
    type: "multiple-files",
    files: [
      {
        fileName: mockProjectPath("Test1.gd"),
        expected: `class_name Test1`,
      },
      {
        fileName: mockProjectPath("Test2.gd"),
        expected: `class_name Test2`,
      },
    ],
  },
}
