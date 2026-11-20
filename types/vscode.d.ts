// The part of the VS Code extension API that src/hosts/vscode/ uses, and nothing more.
//
// `@types/vscode` is the real thing, and is what to swap this for if the extension grows past
// a handful of calls. It is a stand-in until then so that the repository builds with the
// dependencies it already has -- the same reason types/vendor/ holds one-line shims -- and so
// that what the extension is allowed to reach for is a list a reviewer can read.
// The real API declares this globally, and its signatures are written against it.
interface Thenable<T> extends PromiseLike<T> {}

declare module 'vscode' {
  export interface Disposable {
    dispose(): void;
  }
  export interface Event<T> {
    (listener: (e: T) => unknown): Disposable;
  }

  export class Uri {
    static file(path: string): Uri;
    static parse(value: string): Uri;
    static joinPath(base: Uri, ...parts: string[]): Uri;
    readonly scheme: string;
    readonly path: string;
    readonly fsPath: string;
    toString(skipEncoding?: boolean): string;
  }

  export enum FileType {
    Unknown = 0,
    File = 1,
    Directory = 2,
    SymbolicLink = 64,
  }
  export interface FileStat {
    type: FileType;
    ctime: number;
    mtime: number;
    size: number;
  }
  export interface FileSystem {
    stat(uri: Uri): Thenable<FileStat>;
    readDirectory(uri: Uri): Thenable<[string, FileType][]>;
    createDirectory(uri: Uri): Thenable<void>;
    readFile(uri: Uri): Thenable<Uint8Array>;
    writeFile(uri: Uri, content: Uint8Array): Thenable<void>;
    delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Thenable<void>;
    rename(source: Uri, target: Uri, options?: { overwrite?: boolean }): Thenable<void>;
  }

  export class RelativePattern {
    constructor(base: Uri | string, pattern: string);
  }
  export interface FileSystemWatcher extends Disposable {
    onDidChange: Event<Uri>;
    onDidCreate: Event<Uri>;
    onDidDelete: Event<Uri>;
  }

  export enum ColorThemeKind {
    Light = 1,
    Dark = 2,
    HighContrast = 3,
    HighContrastLight = 4,
  }
  export interface ColorTheme {
    readonly kind: ColorThemeKind;
  }

  export enum ViewColumn {
    Active = -1,
    Beside = -2,
    One = 1,
    Two = 2,
  }

  export interface Webview {
    options: WebviewOptions;
    html: string;
    readonly cspSource: string;
    asWebviewUri(localResource: Uri): Uri;
    postMessage(message: unknown): Thenable<boolean>;
    onDidReceiveMessage: Event<any>;
  }
  export interface WebviewOptions {
    enableScripts?: boolean;
    localResourceRoots?: readonly Uri[];
  }
  export interface WebviewPanel extends Disposable {
    readonly webview: Webview;
    readonly visible: boolean;
    title: string;
    onDidDispose: Event<void>;
  }
  export interface WebviewPanelSerializer {
    deserializeWebviewPanel(panel: WebviewPanel, state: any): Thenable<void>;
  }

  export interface TextDocument {
    readonly uri: Uri;
    readonly languageId: string;
  }
  export interface TextEditor {
    readonly document: TextDocument;
  }

  export interface Memento {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void>;
  }
  export interface ExtensionContext {
    readonly subscriptions: Disposable[];
    readonly extensionUri: Uri;
    readonly globalState: Memento;
  }

  export namespace workspace {
    const fs: FileSystem;
    function createFileSystemWatcher(pattern: RelativePattern): FileSystemWatcher;
  }
  export namespace window {
    const activeTextEditor: TextEditor | undefined;
    const activeColorTheme: ColorTheme;
    const onDidChangeActiveColorTheme: Event<ColorTheme>;
    function createWebviewPanel(
      viewType: string,
      title: string,
      showOptions: ViewColumn,
      options?: WebviewOptions & { retainContextWhenHidden?: boolean },
    ): WebviewPanel;
    function registerWebviewPanelSerializer(
      viewType: string,
      serializer: WebviewPanelSerializer,
    ): Disposable;
    function showErrorMessage(message: string): Thenable<string | undefined>;
    function showInformationMessage(message: string): Thenable<string | undefined>;
  }
  export namespace commands {
    function registerCommand(command: string, callback: (...args: any[]) => unknown): Disposable;
  }
}
