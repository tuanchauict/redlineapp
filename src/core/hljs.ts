// The syntax highlighter, with a chosen set of languages rather than all of
// them.
//
// `import hljs from 'highlight.js'` pulls in every one of the 190-odd languages
// it supports. That is free on a server and not free in a webview, where it is
// about 1.5 MB of grammars to parse before the first document can be drawn, for
// a reader that will realistically meet a few dozen of them.
//
// So the set is named here, once, and both the desktop app and the CLI use the
// same one: a fence that highlights on one and not the other would be a worse
// bug than a fence that does not highlight on either. Each language also
// registers its own aliases, so `js`, `ts`, `sh`, `yml`, `html` and the rest
// keep working without being listed.
//
// `plaintext` and `markdown` are not optional. markdown is what the raw view is
// highlighted as, and plaintext is the fallback a fence with no language falls
// back to.
import hljs from 'highlight.js/lib/core';

import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import clojure from 'highlight.js/lib/languages/clojure';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import dart from 'highlight.js/lib/languages/dart';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import elixir from 'highlight.js/lib/languages/elixir';
import erlang from 'highlight.js/lib/languages/erlang';
import go from 'highlight.js/lib/languages/go';
import gradle from 'highlight.js/lib/languages/gradle';
import graphql from 'highlight.js/lib/languages/graphql';
import groovy from 'highlight.js/lib/languages/groovy';
import haskell from 'highlight.js/lib/languages/haskell';
import http from 'highlight.js/lib/languages/http';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import julia from 'highlight.js/lib/languages/julia';
import kotlin from 'highlight.js/lib/languages/kotlin';
import less from 'highlight.js/lib/languages/less';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import nginx from 'highlight.js/lib/languages/nginx';
import nix from 'highlight.js/lib/languages/nix';
import objectivec from 'highlight.js/lib/languages/objectivec';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import properties from 'highlight.js/lib/languages/properties';
import protobuf from 'highlight.js/lib/languages/protobuf';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scala from 'highlight.js/lib/languages/scala';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import vim from 'highlight.js/lib/languages/vim';
import x86asm from 'highlight.js/lib/languages/x86asm';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = {
  bash,
  c,
  clojure,
  cpp,
  csharp,
  css,
  dart,
  diff,
  dockerfile,
  elixir,
  erlang,
  go,
  gradle,
  graphql,
  groovy,
  haskell,
  http,
  ini,
  java,
  javascript,
  json,
  julia,
  kotlin,
  less,
  lua,
  makefile,
  markdown,
  nginx,
  nix,
  objectivec,
  perl,
  php,
  plaintext,
  powershell,
  properties,
  protobuf,
  python,
  r,
  ruby,
  rust,
  scala,
  scss,
  shell,
  sql,
  swift,
  typescript,
  vim,
  x86asm,
  xml,
  yaml,
};

for (const [name, language] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, language);
}

export default hljs;
