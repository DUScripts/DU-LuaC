import fs from "fs";
import path from "path";
import crypto from "crypto";
import luaparse from "luaparse";
import Build from "../types/Build";
import Library from "../types/Library";
import Project from "../types/Project";
import { SimpleMap } from "../types/SimpleMap";
import { CLI } from "./CLI";
import ColorScheme from "./ColorScheme";
import { DULuaCompilerFunctionParser } from "./DULuaCompilerFunctionParser";
import { DULuaCompilerExport } from "./DULuaCompilerExport";
import BuildTarget from "../types/BuildTarget";
import { CompilerVariable, CompilerVariableSet } from "../types/CompilerVariable";
import Utils from "./Utils";

/**
 * Represents a preload generated by the compiler
 */
export type DULuaCompilerPreload = {
  path: string,
  source: string,
  output: string,
};

/**
 * Represents a build result by the compiler
 */
export type DULuaCompilerResult = {
  project: Project,
  build: Build,
  output: string,
  preloads: DULuaCompilerPreload[],
};

/**
 * Represents a compiler file info object
 */
export type DULuaCompilerFileName = {
  project?: string,
  filename: string,
};

/**
 * Represents a compiler file info object
 */
export type DULuaCompilerFileInfo = {
  requireInfo: DULuaCompilerFileName,
  fullpath: string,
};

/**
 * Represents a compiler file info object
 */
export type DULuaCompilerRequire = {
  fullNameWithProject: string,
  sourceCode: string,
};

/**
 * Represents a compiler regular expression
 */
export type DULuaCompilerRegex = {
  expression: RegExp,
  handler: (fullMatch: string, ...matches: string[]) => Promise<string>,
};

/**
 * This is our main compiler, everything that has to do with Lua processing should happen here
 */
export class DULuaCompiler {
  /**
   * Those are the directories our compiler will look into
   */
  private sourceDirectories: string[];

  /**
   * Those are the libraries loaded in our compiler
   */
  private loadedLibraries: SimpleMap<Library> = {};

  /**
   * Those are files loaded by the compiler during build time, via require statements
   */
  private requiredFiles: DULuaCompilerRequire[] = [];

  /**
   * The current value of LUA_PATH
   */
  private readonly loadedLuaPath: string[];

  /**
   * Represents the current file being processed
   */
  private currentFiles: string[] = [];

  /**
   * Represents the current library being processed
   */
  private currentLibraries: (Library | null)[] = [];

  /**
   * Tag used to log information
   */
  private readonly CLITag = 'COMPILE';

  /**
   * The current project, as a library
   */
  private readonly projectLibrary: Library;

  /**
   * The current line of code
   */
  private currentLineOfCode: number[] = [];

  /**
   * The Lua global used for inlined requires
   */
  public static readonly globalInlineRequire = '_REQ';

  /**
   * Those are all variables available during our build
   */
  private buildVariables: CompilerVariableSet = {};

  /**
   * Creates a new compiler instance
   * @param project The project being compiled
   * @param build The build being compiled
   */
  private constructor(
    private project: Project,
    private build: Build,
    private buildTarget: BuildTarget,
    variables: CompilerVariableSet = {}
  ) {
    // Prepares our source path
    this.sourceDirectories = [project.getSourceDirectory()];

    // Creates a library from current project
    this.projectLibrary = Library.loadFromProject(project);

    // Loads our libraries
    [
      this.projectLibrary,
      ...project.getLibraries(),
    ].forEach((library) => {
      this.loadedLibraries[library.id] = library;
    });

    // Loads LUA_PATH
    this.loadedLuaPath = (process.env.LUA_PATH ?? '')
      .split(';')
      .filter(entry => entry.length > 0);

    // Loads our environment variables
    this.buildVariables = Object.assign({}, buildTarget.variables || {}, variables);
  }

  /**
   * Gets the current build that started compilation
   */
  getRunningBuild(): Build {
    return this.build;
  }

  /**
   * Gets the current project that started compilation
   */
  getRunningProject(): Project {
    return this.project;
  }

  /**
   * Gets current source path
   */
  getCurrentDirectory(): string {
    return this.sourceDirectories[0];
  }

  /**
   * Gets the current file being processed
   */
  getCurrentFile(): string {
    return this.currentFiles[0];
  }

  /**
   * Gets the current library being processed
   */
  getCurrentLibrary(): Library | null {
    return this.currentLibraries[0];
  }

  /**
   * Gets all loaded libraries
   */
  getLoadedLibraries(): SimpleMap<Library> {
    return { ...this.loadedLibraries };
  }

  /**
   * Gets the current project being processed
   */
  getCurrentProject(): Project | null {
    return this.getCurrentLibrary()?.getProject() || null;
  }

  /**
   * Gets the current project being processed
   */
  getCurrentLineOfCode(): number {
    return this.currentLineOfCode[0];
  }

  /**
   * Gets the current build target
   */
  getCurrentBuildTarget(): BuildTarget {
    return this.buildTarget;
  }

  /**
   * Adjusts all variables for when we start processing a file
   * @param file The file we're starting processing
   */
  private sourceStartProcessing(file: string, library: Library | null) {
    this.currentLibraries.unshift(library);
    this.sourceDirectories.unshift(path.dirname(file));
    this.currentFiles.unshift(file);
  }

  /**
   * Adjusts all variables for when we finish processing a file
   */
  private sourceFinishProcessing() {
    this.currentFiles.shift();
    this.sourceDirectories.shift();
    this.currentLibraries.shift();
  }

  /**
   * Are we currently working on the root file?
   */
  private isRootFile(): boolean {
    return !this.currentFiles[0];
  }

  /**
   * Parses a string in the project:file syntax
   * @param filename The file we're getting information about
   */
  private parseFileString(filename: string): DULuaCompilerFileName {
    // Fixes the filename to always use forward slashes
    const formattedFilename = filename.replace(/\\/g, '/');

    // Splits our file name from the optional project:file syntax
    const parsedFilename = filename.split(':');

    // When no project is supplied, returns only the filename
    if (parsedFilename.length < 2) {
      return {
        filename: parsedFilename[0],
      };
    }

    // If all info is present, returns everything
    return {
      project: parsedFilename[0],
      filename: parsedFilename[1],
    }
  }

  /**
   * Returns information about a required file
   * @param filename The file we're requiring, in project:file syntax
   */
  public getRequiredFileInfo(filename: string): DULuaCompilerFileInfo | null {
    // Parses file name
    const file = this.parseFileString(filename);

    // Tries to extract a library from our parsed file or defaults to current project
    const library = !!file.project
      ? this.loadedLibraries[file.project]
      : this.projectLibrary;

    // If no library is found, raise an error
    if (!library) {
      CLI.panic(`Library not found for require ${ColorScheme.highlight(filename)}`);
    }

    // This is our "project" prefix
    const projectPrefix = file.project
      ? library.sourcePath
      : this.getCurrentDirectory();

    // Creates our own, internal, LUA_PATH
    const internalLuaPath = [
      // When a project is specified, we'll look up for the file based on its root, otherwise, use relative lookup on current source directory
      path.join(projectPrefix, '?.lua'),
      ...this.loadedLuaPath
    ];

    // Now, convert the internal path into a list of possible file names
    const possibleFilePaths = internalLuaPath.map(
      (path) => path.replace('?', file.filename)
    );

    // Searches for a matching file
    let filepath: string | undefined;
    for (let iFile in possibleFilePaths) {
      if (fs.existsSync(possibleFilePaths[iFile]) && fs.statSync(possibleFilePaths[iFile]).isFile()) {
        filepath = possibleFilePaths[iFile];
        break;
      }
    }

    // Handles required file not found
    if (!filepath) return null;

    // Resolves full file path
    const fullpath = path.resolve(filepath);

    // Does a few extra fixes when we have a library set (which should be always)
    const currentLibrary = this.getCurrentLibrary();
    if (currentLibrary) {
      // Fixes library if necessary
      if (!file.project) {
        file.project = this.getCurrentLibrary()!.id;
      }

      // Properly resolves file path
      file.filename = path.relative(currentLibrary.sourcePath, fullpath).replace(/\\/g, '/');
    }

    // Returns finished result
    return {
      requireInfo: file,
      fullpath,
    };
  }

  /**
   * Returns a parsing error
   * @param err The LuaParse error
   * @param code The code where it happened
   */
  private createParseError(err: any, code: string) {
    // The error subject
    const errorSubject = this.isRootFile()
      ? 'output'
      : ColorScheme.highlight(`file ${this.getCurrentFile()}`);

    // Gets the line where the error happened
    const errorLine = code.split('\n')[err.line - 1];

    return new Error([
      `Error parsing ${errorSubject} at line ${err.line}, column: ${err.column}, index: ${err.index}:`,
      err.message,
      `Problematic line:`,
      ColorScheme.code(errorLine)
    ].join('\n'));
  }

  /**
   * Escapes a string for use inside a regular expression
   * @param str The string being escaped
   */
  private escapeForRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Handles processor directives in the source piece of code
   * @param sourceCode The Lua source-code being processed
   */
  private processDirectives(sourceCode: string): string {
    const directives = [
      // @if, @else and @end
      {
        regex: /---@if (\w+)\w?(.*?)\n([\S\s]*?)\n---@end/gm,
        action: (source: string, compareVariableName: string, compareValue: string, innerCode: string): string => {
          // We'll store our outputs here
          const blocks = {
            'true': innerCode,
            'false': '',
          }

          // Checks if we have an else clause
          if (innerCode.includes('---@else')) {
            const parts = innerCode.split('---@else');
            blocks['true'] = parts[0];
            blocks['false'] = parts[1];
          }

          // If no compare value is provided, assume true
          let parsedValue: CompilerVariable = compareValue;
          if (compareValue.length == 0) {
            parsedValue = true;
          } else {
            try {
              parsedValue = JSON.parse(parsedValue);
            } catch (ex) {}
          }

          // Does the actual comparison
          if (parsedValue == this.buildVariables[compareVariableName] || null) {
            return blocks['true'].trim();
          }
          return blocks['false'].trim();
        }
      },
    ];

    // Processes each of the directives
    for (const directive of directives) {
      sourceCode = sourceCode.replace(directive.regex, directive.action);
    }

    // Done
    return sourceCode;
  }

  /**
   * Processes a piece of code
   * @param sourceCode The Lua source-code being processed
   */
  private async processSourceCode(sourceCode: string): Promise<string> {
    // Replaces any \r\n with just \n for sanity reasons
    sourceCode = sourceCode.replace(/\r\n/g, '\n');

    // Handles processor directives
    sourceCode = this.processDirectives(sourceCode);

    // Validates source AST
    try {
      luaparse.parse(sourceCode);
    } catch (err) {
      throw this.createParseError(err, sourceCode);
    }

    // Clean-up source-code
    const cleanSource = sourceCode
      .replace(/\r/g, '');

    // Prepares our regexes
    const compilerRegexes: SimpleMap<DULuaCompilerRegex> = {
      // Require statements
      require: {
        expression: /(?<!--)require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        handler: async (fullMatch: string, file: string): Promise<string> => {
          // Let's create a temporary version of the source-code without that require inside strings and comments
          const empty = () => '';
          const newRequire = `require([[${file}]])`;
          const newEscapedRequire = this.escapeForRegex(newRequire);
          const escapedRequire = this.escapeForRegex(fullMatch);
          const tempSource = cleanSource
            .replace(escapedRequire, newRequire)
            .replace(new RegExp(`\\[{2}(.|\\n)*?\\]{2}`, 'g'), empty) // Multi-line string literals and comments: [[ something here ]]
            .replace(new RegExp(`-{2}.*`, 'g'), empty) // Single-line comments: -- something here
            .replace(new RegExp(`\\'.*?${newEscapedRequire}.*?\\'`, 'g'), empty) // Single-quote strings: 'something here'
            .replace(new RegExp(`\\".*?${newEscapedRequire}.*?\\"`, 'g'), empty); // Double-quote strings: "something here"

          // Now, check if that require still exists, and if it doesn't, returns the original source code
          if (
            !(new RegExp(escapedRequire).test(tempSource))
          ) {
            return fullMatch;
          }

          // Does the actual require on compiler-side, will return null if nothing is found
          const requireResult = await this.requireFile(file);

          // Handles invalid required file, will leave statement as-is
          if (!requireResult) {
            return fullMatch;
          }

          // Handles inlined requires
          if (!this.build.options.preload) {
            return `${DULuaCompiler.globalInlineRequire}['${requireResult.fullNameWithProject}']`;
          }

          // Returns our modified require
          return `require('${requireResult.fullNameWithProject}')`;
        },
      },

      // Undefined behavior when a period character is right before a line break after a number
      undefinedBehaviorPeriodNewlineNumeric: {
        expression: /([0-9])\?\n/g,
        handler: async function (fullMatch: string, number: string): Promise<string> {
          CLI.warn(`Undefined Behavior: Period character detected directly before line break on numeric value. Completing decimal with zero.`);
          return `${number}.0\n`;
        }
      },

      // Appends custom compiler functions 
      ...(new DULuaCompilerFunctionParser).generateRegex(this),
    };

    // Processes each of the lines of code
    this.currentLineOfCode.unshift(0);
    const lines = sourceCode.split('\n');
    for (const idx in lines) {
      let line = lines[idx];

      // Updates current line of code, in case something needs it
      this.currentLineOfCode[0] = parseInt(idx) + 1;

      // Handles --export statements
      if (DULuaCompilerExport.codeHasExportStatement(line)) {
        line = DULuaCompilerExport.encodeExportStatement(line);
      }

      // Runs our regexes
      for (const regex of Object.values(compilerRegexes)) {
        line = await Utils.replaceAsync(line, regex.expression, regex.handler);
      }
      
      // If we're in renderscript and this is an empty require, we don't need it anymore
      if (!this.build.options.preload && line.match(new RegExp(`^\\s*${DULuaCompiler.globalInlineRequire}\\['.*?'\\]\\s*$`))) {
        return '';
      }

      // Updates processed line of code
      lines[idx] = line;
    }

    this.currentLineOfCode.pop();
    return lines.join('\n');
  }

  /**
   * Requires and processes a file
   * @param filename The file being required, in project:file syntax
   */
  private async requireFile(filename: string): Promise<DULuaCompilerRequire | null> {
    // Gets entrypoint file
    const requiredInfo = this.getRequiredFileInfo(filename);

    // Handles a require not being found
    if (!requiredInfo) {
      // On root file, stops
      if (this.isRootFile()) {
        CLI.panic(`Project file missing: ${ColorScheme.highlight(filename)}`)
      }

      // Checks if we're dealing with any internal library
      if (this.project.internalPaths.filter((path) => filename.startsWith(path)).length > 0) {
        // Don't raise a warning, just notify user
        CLI.status(this.CLITag, `Required a game library ${ColorScheme.highlight(filename)} at file ${ColorScheme.highlight(this.getCurrentFile())}`);
      } else {
        // Raise a warning
        CLI.warn(`Required library ${ColorScheme.highlight(filename)} at file ${ColorScheme.highlight(this.getCurrentFile())} was not found anywhere, leaving statement alone...`);
      }

      // Skips current require
      return null;
    }

    // Detects a loop and stops
    if (this.currentFiles.includes(requiredInfo.fullpath)) {
      throw new Error(`Files required in a loop at ${ColorScheme.highlight(this.getCurrentFile())}`);
    }

    // Creates the full name for our require
    let requireFullName = `${requiredInfo.requireInfo.project || '::extern'}:${requiredInfo.requireInfo.filename}`;

    // Handles external files
    if (!this.project.containsPath(requiredInfo.fullpath)) {
      // Rewrites the require statement if outside the project directory
      const safePathHash = crypto.createHash('sha1')
        .update(requiredInfo.fullpath)
        .digest('hex')
        .slice(0, 10);

      // Creates the new require string
      const newRequireFullName = `${safePathHash}:${path.basename(requiredInfo.fullpath)}`;

      // Status update
      CLI.status(this.CLITag, `External path hashed [${ColorScheme.highlight(newRequireFullName)}] -> ${ColorScheme.highlight(requiredInfo.fullpath)}`);

      // Replaces previous string
      requireFullName = newRequireFullName;
    }

    // Prevents processing the file multiple times
    const existingRequire = this.requiredFiles.filter((entry) => entry.fullNameWithProject == requireFullName);
    if (existingRequire.length > 0) {
      return existingRequire[0];
    }

    // This is our base source code
    const sourceCode = fs.readFileSync(requiredInfo.fullpath).toString();

    // Processes our source code for that require
    CLI.status(this.CLITag, `Compiling file: ${requiredInfo.fullpath}`);
    this.sourceStartProcessing(
      requiredInfo.fullpath,
      requiredInfo.requireInfo.project
        ? this.loadedLibraries[requiredInfo.requireInfo.project]
        : null
    );
    const processedSource = await this.processSourceCode(sourceCode);
    this.sourceFinishProcessing();

    // Creates our entry
    const requireEntry: DULuaCompilerRequire = {
      fullNameWithProject: requireFullName,
      sourceCode: processedSource,
    };

    // Adds ourselves to the require list (if not main file)
    if (!this.isRootFile()) {
      this.requiredFiles.push(requireEntry);
    }

    // Returns our new entry
    return requireEntry;
  }

  /**
   * Runs the actual compilation step
   */
  private async startBuild(requireName?: string): Promise<DULuaCompilerResult> {
    // Prepares our ground
    this.currentLibraries = [Library.loadFromProject(this.project)];

    // Loads our main file via a virtual "require" statement
    const outputLua = await this.requireFile(requireName || `${this.project.name}:${this.build.name}`);

    // Handles compiler fail
    if (!outputLua) {
      CLI.panic(`Build ${ColorScheme.highlight(this.build.name)} failed with no error!`);
    }

    // Those are pre-loaded files we'll add to package.preload
    const outputPreloads: DULuaCompilerPreload[] = this.requiredFiles.map(
      (file) => Object.assign({
        path: file.fullNameWithProject,
        source: file.sourceCode,
        output: `package.preload['${file.fullNameWithProject}'] = (function (...) ${file.sourceCode}; end);`,
      })
    );

    // Done
    return {
      project: this.project,
      build: this.build,
      output: outputLua!.sourceCode,
      preloads: outputPreloads,
    };
  }

  /**
   * Starts a compilation
   * @param project The project hosting our file
   * @param build The file being compiled
   */
  static async compile(project: Project, build: Build, buildTarget: BuildTarget, variables: CompilerVariableSet = {}) {
    return await (new this(project, build, buildTarget, variables)).startBuild();
  }

  /**
   * Starts a compilation of an required file
   * @param project The project hosting our file
   * @param build The file being compiled
   */
  static async compileRequire(project: Project, build: Build, requireName: string, buildTarget: BuildTarget, variables: CompilerVariableSet = {}) {
    return await (new this(project, build, buildTarget, variables)).startBuild(requireName);
  }
}