/*
MIT License

 Copyright 2021 Frank Wagner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

import { LanguageClient } from "vscode-languageclient/node";
import { FindTestsRequest, IFindTestsParams, TestSuite } from "../protocol";
import { ElmTestRunner } from "./runner";

type ElmTestData = WorkspaceTestRoot | ElmProjectTestRoot | ElmTestSuite;

export class ElmTestController implements vscode.TestController<ElmTestData> {
  constructor(
    private readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly client: LanguageClient,
  ) {}

  /**
   * @inheritdoc
   */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  public createWorkspaceTestRoot(
    workspaceFolder: vscode.WorkspaceFolder,
    token: vscode.CancellationToken,
  ) {
    if (workspaceFolder !== this.workspaceFolder) {
      return;
    }
    return WorkspaceTestRoot.create(workspaceFolder, this.client);
  }

  // public createDocumentTestRoot(
  //   document: vscode.TextDocument,
  //   token: vscode.CancellationToken,
  // ): vscode.ProviderResult<
  //   vscode.TestItem<WorkspaceTestRoot, ElmProjectTestRoot>
  // > {
  //   const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  //   if (workspaceFolder !== this.workspaceFolder) {
  //     return;
  //   }
  //   return WorkspaceTestRoot.create(workspaceFolder, this.client);
  // }

  public async runTests(
    request: vscode.TestRunRequest<ElmTestData>,
    cancellation: vscode.CancellationToken,
  ): Promise<void> {
    const run = vscode.test.createTestRun(request);

    const roots = new Set(
      request.tests
        .filter((test) => !request.exclude?.includes(test))
        .map((test) =>
          test.data instanceof ElmProjectTestRoot
            ? test.data
            : test.data instanceof ElmTestSuite
            ? test.data.root
            : undefined,
        )
        .filter(notUndefined),
    );

    await Promise.all(
      Array.from(roots).map((root) => {
        const uris = new Set(
          request.tests
            .filter((test) => !request.exclude?.includes(test))
            .filter(
              (test) =>
                test.data instanceof ElmTestSuite && test.data.root === root,
            )
            .map((test) =>
              test.data instanceof ElmTestSuite ? test.uri : undefined,
            )
            .filter(notUndefined),
        );
        const findAffected = (
          test: vscode.TestItem<ElmTestData>,
        ): readonly vscode.TestItem<ElmTestData>[] =>
          Array.from(test.children.values())
            // .filter((test) => test.uri && uris.has(test.uri))
            .flatMap((test) => [test, ...findAffected(test)]);

        const affected = Array.from(root.item.children.values())
          // .filter((test) => test.uri && uris.has(test.uri))
          .flatMap((test) => [test, ...findAffected(test)]);

        const fsPaths = new Set(Array.from(uris).map((uri) => uri.fsPath));
        affected
          .filter((test) => test.uri && fsPaths.has(test.uri.fsPath))
          .forEach((test) =>
            run.setState(test, vscode.TestResultState.Running),
          );
        return root.run(Array.from(uris), run);
      }),
    ).then(() => run.end());
  }
}

class WorkspaceTestRoot {
  public static create(
    workspaceFolder: vscode.WorkspaceFolder,
    client: LanguageClient,
  ): vscode.TestItem<WorkspaceTestRoot, ElmProjectTestRoot> {
    const name = path.basename(workspaceFolder.uri.fsPath);
    const item = vscode.test.createTestItem<
      WorkspaceTestRoot,
      ElmProjectTestRoot
    >(
      {
        id: `elmTests ${workspaceFolder.uri.toString()}`,
        label: `Elm Tests (${name})`,
        uri: workspaceFolder.uri,
      },
      new WorkspaceTestRoot(workspaceFolder),
    );

    item.status = vscode.TestItemStatus.Pending;
    item.resolveHandler = (token) => {
      // const contentChange = new vscode.EventEmitter<vscode.Uri>();

      // watcher.onDidCreate(uri =>
      //   item.addChild(TestFile.create(uri, getContentFromFilesystem, contentChange.event))
      // );
      // watcher.onDidChange(uri => contentChange.fire(uri));
      // watcher.onDidDelete(uri => item.children.get(uri.toString())?.dispose());
      // token.onCancellationRequested(() => {
      //   item.status = vscode.TestItemStatus.Pending;
      //   watcher.dispose();
      // });

      token.onCancellationRequested(() => {
        item.status = vscode.TestItemStatus.Pending;
        // watcher.dispose();
      });

      void vscode.workspace
        .findFiles(
          new vscode.RelativePattern(workspaceFolder, "**/elm.json"),
          new vscode.RelativePattern(
            workspaceFolder,
            "**/{node_modules,elm-stuff}/**",
          ),
        )
        .then((elmJsons) => {
          elmJsons.forEach((elmJsonPath) => {
            const elmProjectFolder = vscode.Uri.parse(
              path.dirname(elmJsonPath.fsPath),
            );
            if (fs.existsSync(path.join(elmProjectFolder.fsPath, "tests"))) {
              item.addChild(
                ElmProjectTestRoot.create(
                  elmProjectFolder,
                  workspaceFolder,
                  client,
                  // contentChange.event,
                ),
              );
            }
          });
          item.status = vscode.TestItemStatus.Resolved;
        });
    };

    return item;
  }

  constructor(public readonly workspaceFolder: vscode.WorkspaceFolder) {}
}

class ElmProjectTestRoot {
  public static create(
    elmProjectFolder: vscode.Uri,
    workspaceFolder: vscode.WorkspaceFolder,
    client: LanguageClient,
  ): vscode.TestItem<ElmProjectTestRoot, ElmTestSuite> {
    const name = path.basename(elmProjectFolder.fsPath);
    const item = vscode.test.createTestItem<ElmProjectTestRoot, ElmTestSuite>({
      id: `elmProject ${elmProjectFolder.toString()}`,
      label: `${name}`,
      uri: elmProjectFolder,
    });
    (item.data = new ElmProjectTestRoot(
      elmProjectFolder,
      workspaceFolder,
      item,
    )),
      (item.status = vscode.TestItemStatus.Pending);
    item.resolveHandler = (token) => {
      const input: IFindTestsParams = {
        projectFolder: elmProjectFolder.toString(),
      };
      void client.sendRequest(FindTestsRequest, input).then((response) => {
        response.suites?.forEach((suite) =>
          item.addChild(ElmTestSuite.create(suite, item, item.data)),
        );
        item.status = vscode.TestItemStatus.Resolved;
      });

      // item.addChild(ElmTestSuite.create("fw1", item));
      // item.addChild(ElmTestSuite.create("fw2", item));
    };
    return item;
  }

  constructor(
    public readonly elmProjectFolder: vscode.Uri,
    public readonly workspaceFolder: vscode.WorkspaceFolder,
    public readonly item: vscode.TestItem<ElmProjectTestRoot, ElmTestSuite>,
  ) {}

  async run(
    uris: vscode.Uri[],
    run: vscode.TestRun<ElmTestData>,
  ): Promise<void> {
    const runner = new ElmTestRunner(
      this.workspaceFolder,
      this.elmProjectFolder,
      // this.log,
    );
    const suiteOrError = await runner.runSomeTests(
      uris.map((uri) => uri.toString()),
    );
    if (typeof suiteOrError === "string") {
      const message: vscode.TestMessage = {
        message: suiteOrError,
        severity: vscode.TestMessageSeverity.Error,
      };
      run.appendMessage(this.item, message);
      run.setState(this.item, vscode.TestResultState.Failed);
    } else {
      const suites = suiteOrError.children;
      // const suite = this.getRootSuite(suites);
      // this.loadedSuite = mergeTopLevelSuites(suite, this.loadedSuite);
      // this.fireLoaded(this.loadedSuite);
      // this.fireRun(suiteOrError, getLineFun(this.loadedSuite));
      run.setState(this.item, vscode.TestResultState.Passed);
    }
  }
}

class ElmTestSuite {
  public static create(
    suite: TestSuite,
    parent: vscode.TestItem<ElmProjectTestRoot | ElmTestSuite>,
    root: ElmProjectTestRoot,
  ): vscode.TestItem<ElmTestSuite, ElmTestSuite> {
    const item = vscode.test.createTestItem<ElmTestSuite, ElmTestSuite>(
      {
        id: `elmTestSuite/${parent.uri?.toString() ?? "?"}/${suite.label}`,
        label: `${suite.label}`,
        uri: vscode.Uri.parse(suite.file),
      },
      new ElmTestSuite(suite, root),
    );
    suite.tests?.forEach((test) =>
      item.addChild(ElmTestSuite.create(test, item, root)),
    );
    item.range = new vscode.Range(
      suite.position.line,
      suite.position.character,
      suite.position.line,
      suite.position.character,
    );
    return item;
  }
  constructor(
    public readonly suite: TestSuite,
    public readonly root: ElmProjectTestRoot,
  ) {}
}

// TODO share?
function notUndefined<T>(x: T | undefined): x is T {
  return x !== undefined;
}
