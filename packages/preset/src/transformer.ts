import ts, { TransformationContext, Transformer } from "typescript";
import * as Path from "node:path";
import { transform as cssTransform } from "lightningcss";
import * as sass from "sass";
import fs from "node:fs";
import resolve, { type SyncOpts } from "resolve";
import { pathToFileURL, fileURLToPath } from "node:url";

const EXT = [".css", ".scss", ".less", ".styl"];

export const getUrlOfPartial = (url: string) => {
  const parsedUrl = Path.parse(url);
  return `${parsedUrl.dir}${Path.sep}_${parsedUrl.base}`;
};

function parseExports(pkg: any) {
  if (!pkg.exports) return null;

  const exp = pkg.exports?.["."];
  if (!exp) return null;

  if (exp.sass) {
    return exp.sass;
  }
}

export function compileSass(importer: string, buffer: string, ident: boolean) {
  const ret = sass.compileString(buffer, {
    syntax: ident ? "indented" : "scss",
    loadPaths: [Path.dirname(importer)],
    importers: [
      {
        findFileUrl(url, ctx) {
          const moduleUrl = url;
          const partialUrl = getUrlOfPartial(moduleUrl);

          let impor = importer;

          if (ctx.containingUrl) {
            impor = fileURLToPath(ctx.containingUrl);
          }

          const options = {
            basedir: Path.dirname(impor),
            extensions: [".scss", ".sass", ".css"],
            includeCoreModules: false,
            packageFilter(pkg, file, dir) {
              const exported = parseExports(pkg);
              if (exported) {
                pkg.main = exported;
              }
              return pkg;
            },
            pathFilter(pkg, path, relativePath) {
              const ext = Path.extname(relativePath);
              if (!ext) {
                relativePath += ".scss";
              }

              return relativePath;
            },
          } satisfies SyncOpts;

          let resolved: string | undefined;

          try {
            resolved = resolve.sync(moduleUrl, options);
          } catch {
            return null;
          }

          return pathToFileURL(resolved);
        },
      },
    ],
  });

  return ret.css;
}

function preprocessStyling(path: string, ext: string, buffer: string) {
  if (ext == ".scss" || ext == ".sass") {
    return compileSass(path, buffer, ext == ".sass");
  }

  return buffer;
}

function getStyleIdent(decl: ts.ImportDeclaration) {
  if (!decl.importClause) {
    return null;
  }

  if (decl.importClause.name) {
    return decl.importClause.name;
  } else if (ts.isNamespaceImport(decl.importClause.namedBindings)) {
    return decl.importClause.namedBindings.name;
  } else {
    return null;
  }
}

export function visitStatements(
  root: string,
  directory: string,
  ctx: TransformationContext,
  stmts: ts.NodeArray<ts.Statement>,
  css: { path: string; code: Uint8Array }[],
  libraryName?: string
): ts.Statement[] {
  const mapped = [...stmts]
    .map((stmt) => {
      if (ts.isImportDeclaration(stmt)) {
        const ext = Path.extname(
          (stmt.moduleSpecifier as ts.StringLiteral).text
        );

        if (!EXT.includes(ext)) return stmt;

        const resolvePath = Path.join(
          directory,
          (stmt.moduleSpecifier as ts.StringLiteral).text
        );

        let source = fs.readFileSync(resolvePath, "utf-8");
        source = preprocessStyling(resolvePath, ext, source);

        const isModule = resolvePath.includes(".module.");

        const { code, exports } = cssTransform({
          cssModules: isModule
            ? {
                pattern: libraryName
                  ? `${libraryName}_[hash]__[local]`
                  : "[hash]__[local]",
              }
            : false,
          filename: resolvePath,
          code: Buffer.from(source),
        });

        let outputName =
          "." +
          resolvePath
            .replace(directory, "")
            .replace(".module.", ".")
            .replace(ext, ".css");

        if (isModule) {
          outputName = outputName.replace(".module.", ".");
        }

        css.push({
          path: resolvePath
            .replace(root, "")
            .replace(".module.", ".")
            .replace(ext, ".css"),
          code,
        });

        if (exports) {
          const o = [...Object.entries(exports)].map(([k, v]) => {
            return ctx.factory.createPropertyAssignment(
              ctx.factory.createStringLiteral(k),
              ctx.factory.createStringLiteral(v.name)
            );
          });

          const ident = getStyleIdent(stmt);

          if (!ident)
            throw new Error("only support default or namespace import");

          const classMap = ctx.factory.createVariableStatement(
            [],
            [
              ctx.factory.createVariableDeclaration(
                ident.text,
                void 0,
                void 0,
                ctx.factory.createObjectLiteralExpression(o)
              ),
            ]
          );

          const impo = ctx.factory.createImportDeclaration(
            [],
            void 0,
            ctx.factory.createStringLiteral(outputName)
          );

          return [impo, classMap];
        }

        return ctx.factory.updateImportDeclaration(
          stmt,
          [...(stmt.modifiers ?? [])],
          stmt.importClause,
          ctx.factory.createStringLiteral(outputName),
          stmt.attributes
        );
      }

      return stmt;
    })
    .flat();

  return mapped;
}

export function transform(
  root: string,
  css: { path: string; code: Uint8Array }[],
  libraryName?: string
) {
  return function (ctx: TransformationContext): Transformer<ts.SourceFile> {
    return function (node: ts.SourceFile) {
      if (ts.isSourceFile(node)) {
        const dir = Path.dirname(node.fileName);
        const stmts = visitStatements(
          root,
          dir,
          ctx,
          node.statements,
          css,
          libraryName
        );

        return ctx.factory.updateSourceFile(node, stmts);
      }

      return node;
    };
  };
}
