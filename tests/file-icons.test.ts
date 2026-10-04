import { describe, expect, it } from "vitest";

import { FILE_ICON_TONE, fileIconKind, type FileIconKind } from "../client/lib/fileIcons.js";

describe("workspace file icons", () => {
  it("classifies every icon kind and applies precedence to special filenames", () => {
    const cases: Array<[string, "file" | "directory", FileIconKind, boolean?]> = [
      ["src", "directory", "folder", false],
      ["src", "directory", "folder-open", true],
      ["index.ts", "file", "code"],
      ["package.json", "file", "json"],
      ["README.MD", "file", "markdown"],
      ["site.scss", "file", "style"],
      ["index.html", "file", "html"],
      ["logo.png", "file", "image"],
      ["settings.toml", "file", "config"],
      ["run.sh", "file", "shell"],
      ["package-lock.json", "file", "lock"],
      ["app.env.local", "file", "file"],
      [".env.local", "file", "env"],
      [".gitignore", "file", "git"],
      ["notes.txt", "file", "text"],
      ["LICENSE", "file", "file"],
      ["yarn.lock", "file", "lock"],
      ["npm-shrinkwrap.json", "file", "lock"],
      ["pnpm-lock.yaml", "file", "lock"],
      ["bun.lockb", "file", "lock"],
      ["bun.lock", "file", "lock"],
      ["cargo.lock", "file", "lock"],
      ["composer.lock", "file", "lock"],
      ["Gemfile.lock", "file", "lock"],
      ["poetry.lock", "file", "lock"],
      ["anything.LOCK", "file", "lock"],
      [".gitattributes", "file", "git"],
      [".gitmodules", "file", "git"],
      [".gitkeep", "file", "git"],
      [".env", "file", "env"],
      ["Dockerfile", "file", "config"],
      ["Makefile", "file", "config"],
      [".editorconfig", "file", "config"],
      [".npmrc", "file", "config"],
      [".nvmrc", "file", "config"],
      [".dockerignore", "file", "config"],
      [".prettierrc", "file", "config"],
      [".eslintrc", "file", "config"],
      ["component.tsx", "file", "code"],
      ["module.mts", "file", "code"],
      ["module.cts", "file", "code"],
      ["script.js", "file", "code"],
      ["view.jsx", "file", "code"],
      ["module.mjs", "file", "code"],
      ["module.cjs", "file", "code"],
      ["script.py", "file", "code"],
      ["script.rb", "file", "code"],
      ["main.go", "file", "code"],
      ["main.rs", "file", "code"],
      ["Main.java", "file", "code"],
      ["Main.kt", "file", "code"],
      ["Main.swift", "file", "code"],
      ["main.c", "file", "code"],
      ["main.h", "file", "code"],
      ["main.cpp", "file", "code"],
      ["main.hpp", "file", "code"],
      ["main.cs", "file", "code"],
      ["main.php", "file", "code"],
      ["App.vue", "file", "code"],
      ["App.svelte", "file", "code"],
      ["query.sql", "file", "code"],
      ["data.jsonc", "file", "json"],
      ["data.json5", "file", "json"],
      ["content.mdx", "file", "markdown"],
      ["content.markdown", "file", "markdown"],
      ["site.css", "file", "style"],
      ["site.sass", "file", "style"],
      ["site.less", "file", "style"],
      ["index.htm", "file", "html"],
      ["photo.jpg", "file", "image"],
      ["photo.jpeg", "file", "image"],
      ["animation.gif", "file", "image"],
      ["icon.svg", "file", "image"],
      ["image.webp", "file", "image"],
      ["favicon.ico", "file", "image"],
      ["photo.avif", "file", "image"],
      ["photo.bmp", "file", "image"],
      ["settings.yaml", "file", "config"],
      ["settings.yml", "file", "config"],
      ["settings.ini", "file", "config"],
      ["settings.conf", "file", "config"],
      ["settings.xml", "file", "config"],
      ["run.bash", "file", "shell"],
      ["run.zsh", "file", "shell"],
      ["run.fish", "file", "shell"],
      ["run.ps1", "file", "shell"],
      ["output.log", "file", "text"],
      ["data.csv", "file", "text"],
      [".foorc", "file", "config"],
      [".eslintrc.json", "file", "json"],
      ["foo.test.ts", "file", "code"],
      ["src/index.ts", "file", "code"],
      ["pnpm-workspace.yaml", "file", "config"],
      ["logo.bin", "file", "file"],
    ];

    for (const [name, type, expected, expanded] of cases) {
      expect(fileIconKind(name, type, expanded), `${name} (${type})`).toBe(expected);
    }
  });

  it("uses case-insensitive basename matching for paths and special names", () => {
    expect(fileIconKind("src/index.ts", "file")).toBe("code");
    expect(fileIconKind("README.MD", "file")).toBe("markdown");
    expect(fileIconKind("Dockerfile", "file")).toBe("config");
    expect(fileIconKind("package-lock.JSON", "file")).toBe("lock");
  });

  it("classifies lockfiles before their extensions", () => {
    expect(fileIconKind("package-lock.json", "file")).toBe("lock");
    expect(fileIconKind("pnpm-lock.yaml", "file")).toBe("lock");
    expect(fileIconKind("package.json", "file")).toBe("json");
    expect(fileIconKind("pnpm-workspace.yaml", "file")).toBe("config");
  });

  it("provides a tone for every icon kind", () => {
    const kinds: FileIconKind[] = [
      "folder",
      "folder-open",
      "code",
      "json",
      "markdown",
      "style",
      "html",
      "image",
      "config",
      "shell",
      "lock",
      "env",
      "git",
      "text",
      "file",
    ];

    for (const kind of kinds) expect(FILE_ICON_TONE[kind], kind).toBeDefined();
  });
});
