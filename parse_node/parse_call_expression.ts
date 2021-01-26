import ts, {
  isExpressionWithTypeArguments,
  SyntaxKind,
  TypeFlags,
} from "typescript"
import { combine, ParseState } from "../parse_node"
import { ParseNodeType } from "../parse_node"
import { Test } from "../test"
import { isArrayType, isDictionary } from "../ts_utils"
import { getCapturedScope } from "./parse_arrow_function"

type LibraryFunctionName = "map" | "filter"
const LibraryFunctions: {
  [key in LibraryFunctionName]: {
    name: LibraryFunctionName
    definition: (name: string) => string
  }
} = {
  map: {
    name: "map",
    definition: (name: string) => `
func ${name}(list, fn, captures):
  var result = []

  for item in list:
    result.append(fn.call_func(item, captures))

  return result
    `,
  },

  filter: {
    name: "filter",
    definition: (name: string) => `
func ${name}(list, fn, captures):
  var result = []

  for item in list:
    if fn.call_func(item, captures):
      result.append(item)

  return result
    `,
  },
}

export const parseCallExpression = (
  node: ts.CallExpression,
  props: ParseState
): ParseNodeType => {
  let expression = node.expression
  let args = node.arguments

  if (node.expression.kind === SyntaxKind.SuperKeyword) {
    return combine({
      parent: node,
      nodes: node.expression,
      props,
      content: () => "",
    })
  }

  // This block compiles vec.add(vec2) into vec + vec2.

  // node = [[ a.b(c) ]]
  if (node.expression.kind === SyntaxKind.PropertyAccessExpression) {
    // prop = [[ a.b ]](c)
    const prop = node.expression as ts.PropertyAccessExpression
    const functionName = prop.name.getText()

    const type = props.program
      .getTypeChecker()
      .getTypeAtLocation(prop.expression)
    const stringType = props.program.getTypeChecker().typeToString(type)

    if (isArrayType(type)) {
      if (functionName in LibraryFunctions) {
        const libFunctionName = functionName as LibraryFunctionName

        if (node.arguments[0].kind !== SyntaxKind.ArrowFunction) {
          throw new Error("Can't do map w/o an arrow function!")
        }

        const arrowFunction = node.arguments[0] as ts.ArrowFunction

        const { capturedScopeObject } = getCapturedScope(
          arrowFunction,
          props.program.getTypeChecker()
        )

        const result = combine({
          parent: node,
          nodes: [prop.expression, ...args],
          props,
          content: (expr, ...args) => {
            return `__${libFunctionName}(${[expr, ...args].join(
              ", "
            )}, ${capturedScopeObject})`
          },
        })

        result.hoistedLibraryFunctions = [
          LibraryFunctions[libFunctionName].definition("__" + libFunctionName),
        ]

        return result
      }
    }

    if (
      stringType === "Vector2" ||
      stringType === "Vector2i" ||
      stringType === "Vector3" ||
      stringType === "Vector3i"
    ) {
      let operator: undefined | string = undefined

      if (functionName === "add") operator = "+"
      if (functionName === "sub") operator = "-"
      if (functionName === "mul") operator = "*"
      if (functionName === "div") operator = "/"

      if (operator) {
        return combine({
          parent: node,
          nodes: [prop.expression, node.arguments[0]],
          props,
          content: (exp, arg) => `${exp} ${operator} ${arg}`,
        })
      }
    }
  }

  // This compiles dict.put(a, b) into dict[a] = b
  if (expression.kind === SyntaxKind.PropertyAccessExpression) {
    const propAccess = expression as ts.PropertyAccessExpression

    if (
      isDictionary(
        props.program.getTypeChecker().getTypeAtLocation(propAccess.expression)
      ) &&
      propAccess.name.escapedText === "put"
    ) {
      return combine({
        parent: node,
        nodes: [propAccess.expression, args[0], args[1]],
        props,
        content: (dict, key, val) => `${dict}[${key}] = ${val}`,
      })
    }
  }

  const decls = props.program
    .getTypeChecker()
    .getTypeAtLocation(node.expression).symbol?.declarations
  const isArrowFunction =
    decls &&
    decls[0].kind === SyntaxKind.ArrowFunction &&
    decls[0].getSourceFile() === node.getSourceFile()

  console.log(expression.getText())
  // console.log(isDictionary(exprType))
  // console.log(props.program.getTypeChecker().typeToString(exprType))
  // if (rhs === "put") {
  //   rhs = "put!"
  // }

  return combine({
    parent: node,
    nodes: [expression, ...args],
    props,
    content: (expr, ...args) => {
      if (expr === "Yield") {
        expr = "yield"
      }

      if (expr === "emit_signal") {
        if (args[0].startsWith("this")) {
          args[0] = args[0].slice("this.".length)
        }

        args[0] = '"' + args[0] + '"'
      }

      if (isArrowFunction) {
        const { capturedScopeObject } = getCapturedScope(
          decls[0] as ts.ArrowFunction,
          props.program.getTypeChecker()
        )

        return `${expr}.call_func(${[...args, capturedScopeObject].join(", ")})`
      }

      return `${expr}(${args.join(", ")})`
    },
  })
}

export const testBasicCall: Test = {
  ts: `foo("bar")`,
  expected: `foo("bar")`,
}

export const testAddVec: Test = {
  ts: `const v1: Vector2; const v2: Vector2; v1.add(v2)`,
  expected: `
var v1
var v2
v1 + v2
`,
}

export const testAddVec2: Test = {
  expectFail: true,
  ts: `const foo: { v: Vector2; }; const v2: Vector2; foo.v.add(v2)`,
  expected: `
var foo
var v2
foo['v'] + v2
`,
}

export const testNormalVec: Test = {
  ts: `const v1: Vector2; v1.distance_to(v1)`,
  expected: `
var v1
v1.distance_to(v1)
`,
}

export const testArrowFunction: Test = {
  ts: `
const test = () => 5;
test()  
  `,
  expected: `
func func1(captures):
  return 5
var test = funcref(self, "func1")
test.call_func({})
`,
}

export const testMap: Test = {
  ts: `
let x: string[] = ['a', 'b', 'c']
x.map(y => y + '1')
  `,
  expected: `
${LibraryFunctions.map.definition("__map")}
func func1(y: String, captures):
  return y + "1"
var x = ["a", "b", "c"]
__map(x, funcref(self, "func1"), {})
`,
}

export const testMapCapture: Test = {
  ts: `
let x = [1, 2, 3]
let z = 5
let big = { a : 6 }
x.map((y: int) => {
  return z + big.a + y * 3
})
  `,
  expected: `
${LibraryFunctions.map.definition("__map")}
func func1(y, captures):
  var z = captures.z
  var big = captures.big
  return z + big.a + y * 3
var x = [1, 2, 3]
var z: int = 5
var big = { "a": 6 }
__map(x, funcref(self, "func1"), {"z": z, "big": big})
`,
}

// TODO: this also fails lol
// for (let i = 0; i < 3; i++) {

// }
// return z + big.a + y * 3

// TODO this also fails bc it's double quoted.
// let big = { "a" : 6 }

export const testRewriteDictPut: Test = {
  ts: `
let d = todict({ 'a': 1 })
d.put('b', 2)
  `,
  expected: `
var d = todict({ "a": 1 })
d["b"] = 2
`,
}

export const testRewriteDictPut2: Test = {
  ts: `
let d = todict({ 'a': 1 })
d.put([1, 2], 2)
  `,
  expected: `
var d = todict({ "a": 1 })
d[[1, 2]] = 2
`,
}
