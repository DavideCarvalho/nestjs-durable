import {
  type CallExpression,
  Node,
  type ObjectLiteralExpression,
  Project,
  type SourceFile,
  SyntaxKind,
} from 'ts-morph';

/**
 * `durable migrate nestjs-workflows <glob>`: rewrites code written against the official
 * `@nestjs/workflows` to nestjs-durable where the mapping is 1:1, and leaves a
 * `// TODO(durable-migrate): …` comment above every statement it can't map (the code is kept as it
 * was there, so the compiler points at it too).
 *
 * Mapped: imports, `@Workflow('name', { version })`, `ctx.step` (→ `ctx.localStep`, with
 * `retry: n` → `retries`, `timeout` → `timeoutMs`), `ctx.sleep(name, d | { until })`,
 * `ctx.waitForSignal(name, signal, { key, timeout })` (→ the token `<signal>:<key>`),
 * `ctx.waitForAny(name, { … })` with `ctx.signalWait(signal, { key })` (→ the token), `ctx.timer`
 * and child handles (→ `ctx.childWait(id)`), `ctx.executeChild` / `ctx.startChild` (with `id`,
 * `parentClose`), `ctx.now/random/uuid`, `ctx.fail`, `ctx.setStatus` (→ `ctx.setEvent('status', …)`),
 * `ctx.workflowId`, `WorkflowClient.start/signal/result` (→ `WorkflowService`; `signal`'s dedupe
 * `id` carries over), `WorkflowsModule.forRoot`.
 */

const OFFICIAL = '@nestjs/workflows';
const DURABLE = '@dudousxd/nestjs-durable';
const CORE = '@dudousxd/nestjs-durable-core';
export const TODO = 'TODO(durable-migrate)';
/** Where the rewritten imports go: the first official import's place. */
const IMPORT_SLOT = '\u0000durable-migrate-imports\u0000';

/** Official import → durable import. Names absent here are left on a TODO. */
const IMPORT_MAP: Record<string, { from: string; name: string; type?: boolean }> = {
  Workflow: { from: DURABLE, name: 'Workflow' },
  WorkflowContext: { from: DURABLE, name: 'WorkflowCtx', type: true },
  WorkflowClient: { from: DURABLE, name: 'WorkflowService' },
  WorkflowsModule: { from: DURABLE, name: 'DurableModule' },
  NonRetryableStepError: { from: CORE, name: 'FatalError' },
  WorkflowCondition: { from: CORE, name: 'WaitCondition', type: true },
  WorkflowAnyResult: { from: CORE, name: 'WaitAnyResult', type: true },
};

export interface MigrationResult {
  text: string;
  changed: boolean;
  todos: number;
}

/** `'30s'` / `90_000` → ms, or `undefined` when it isn't a literal we can read. */
function literalMs(node: Node | undefined): number | undefined {
  if (!node) return undefined;
  if (Node.isNumericLiteral(node)) return Number(node.getLiteralValue());
  if (!Node.isStringLiteral(node) && !Node.isNoSubstitutionTemplateLiteral(node)) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/.exec(node.getLiteralValue().trim());
  if (!match) return undefined;
  const unit = { ms: 1, s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8 }[
    match[2] ?? 'ms'
  ] as number;
  return Math.round(Number(match[1]) * unit);
}

function props(node: Node | undefined): Map<string, Node> | undefined {
  if (!node || !Node.isObjectLiteralExpression(node)) return undefined;
  const out = new Map<string, Node>();
  for (const p of (node as ObjectLiteralExpression).getProperties()) {
    if (Node.isPropertyAssignment(p)) out.set(p.getName(), p.getInitializerOrThrow());
    else if (Node.isShorthandPropertyAssignment(p)) out.set(p.getName(), p.getNameNode());
    else return undefined; // spread / method: not a plain literal
  }
  return out;
}

class Migration {
  private todos: string[] = [];
  private total = 0;
  readonly usedDurable = new Set<string>();
  readonly usedCore = new Set<string>();
  /** Official names imported in this file, by local name. */
  private readonly imported = new Map<string, string>();
  private readonly importDecls: Node[] = [];

  constructor(private readonly file: SourceFile) {
    for (const decl of file.getImportDeclarations()) {
      if (decl.getModuleSpecifierValue() !== OFFICIAL) continue;
      this.importDecls.push(decl);
      for (const spec of decl.getNamedImports()) {
        this.imported.set(spec.getAliasNode()?.getText() ?? spec.getName(), spec.getName());
      }
    }
  }

  get applies(): boolean {
    return this.importDecls.length > 0;
  }

  run(): MigrationResult {
    const original = this.file.getFullText();
    let body = '';
    for (const child of this.file.getChildren()) body += this.render(child);
    // The durable imports take the place of the first official import.
    const header = this.importHeader();
    const text = body
      .replace(IMPORT_SLOT, header)
      .replace(new RegExp(`\\n?${IMPORT_SLOT}`, 'g'), '');
    return { text, changed: text !== original, todos: this.total };
  }

  private todo(message: string): void {
    this.todos.push(message);
    this.total += 1;
  }

  /** The official name an identifier refers to, through this file's imports. */
  private officialName(node: Node): string | undefined {
    if (!Node.isIdentifier(node)) return undefined;
    const name = this.imported.get(node.getText());
    if (!name) return undefined;
    const decl = node.getSymbol()?.getDeclarations()[0];
    return decl && Node.isImportSpecifier(decl) ? name : undefined;
  }

  /** Whether `node` is a reference to a parameter/property typed with the official `type`. */
  private typedAs(node: Node, type: string): boolean {
    const target =
      Node.isPropertyAccessExpression(node) && Node.isThisExpression(node.getExpression())
        ? node.getNameNode()
        : node;
    if (!Node.isIdentifier(target)) return false;
    for (const decl of target.getSymbol()?.getDeclarations() ?? []) {
      if (
        Node.isParameterDeclaration(decl) ||
        Node.isPropertyDeclaration(decl) ||
        Node.isVariableDeclaration(decl)
      ) {
        const typeNode = decl.getTypeNode();
        if (
          typeNode &&
          Node.isTypeReference(typeNode) &&
          this.officialName(typeNode.getTypeName()) === type
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /** The text of `node` with its own leading trivia removed. */
  private r(node: Node): string {
    const full = this.render(node);
    return full.slice(node.getStart() - node.getPos());
  }

  private leading(node: Node): string {
    return node.getFullText().slice(0, node.getStart() - node.getPos());
  }

  private render(node: Node): string {
    const statementLike =
      Node.isStatement(node) ||
      Node.isClassDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isPropertyDeclaration(node) ||
      Node.isConstructorDeclaration(node);
    const saved = this.todos;
    if (statementLike) this.todos = [];
    let out = this.transform(node);
    if (out === undefined) {
      const children = node.getChildren();
      out =
        children.length === 0 ? node.getFullText() : children.map((c) => this.render(c)).join('');
    }
    if (statementLike) {
      const mine = this.todos;
      this.todos = saved;
      if (mine.length > 0) {
        const lead = this.leading(node);
        const indent = /[ \t]*$/.exec(lead)?.[0] ?? '';
        const comments = mine.map((m) => `// ${TODO}: ${m}\n${indent}`).join('');
        out = lead + comments + out.slice(lead.length);
      }
    }
    return out;
  }

  /** The new full text of `node`, or `undefined` to render it child by child. */
  private transform(node: Node): string | undefined {
    if (Node.isImportDeclaration(node) && this.importDecls.includes(node)) {
      return this.leading(node) + IMPORT_SLOT;
    }
    if (Node.isIdentifier(node)) {
      const official = this.officialName(node);
      const parent = node.getParent();
      if (official && !Node.isImportSpecifier(parent)) {
        const mapped = IMPORT_MAP[official];
        if (mapped) {
          (mapped.from === DURABLE ? this.usedDurable : this.usedCore).add(
            mapped.type ? `type ${mapped.name}` : mapped.name,
          );
          return this.leading(node) + mapped.name;
        }
        this.todo(
          `\`${official}\` from @nestjs/workflows has no direct durable equivalent; see the migration guide`,
        );
      }
      return undefined;
    }
    if (Node.isDecorator(node)) return this.workflowDecorator(node);
    if (Node.isExpressionStatement(node)) return this.statement(node);
    if (Node.isPropertyAccessExpression(node) && !Node.isCallExpression(node.getParent())) {
      if (this.typedAs(node.getExpression(), 'WorkflowContext')) {
        const name = node.getName();
        if (name === 'workflowId')
          return `${this.leading(node)}${this.r(node.getExpression())}.runId`;
        if (name === 'workflowName' || name === 'version' || name === 'schedule') {
          this.todo(
            `ctx.${name} has no durable equivalent (read it from the run: WorkflowService / the engine)`,
          );
        }
      }
      return undefined;
    }
    if (Node.isCallExpression(node)) return this.call(node);
    return undefined;
  }

  private workflowDecorator(node: Node): string | undefined {
    if (!Node.isDecorator(node)) return undefined;
    const call = node.getCallExpression();
    if (!call || this.officialName(call.getExpression()) !== 'Workflow') return undefined;
    const [name, options] = call.getArguments();
    if (!name) return undefined;
    this.usedDurable.add('Workflow');
    const fields = [`name: ${this.r(name)}`];
    const opts = props(options);
    if (options && !opts) this.todo('@Workflow options could not be read; map them by hand');
    for (const [key, value] of opts ?? []) {
      if (key === 'version') fields.push(`version: '${value.getText().replace(/['"]/g, '')}'`);
      else
        this.todo(
          `@Workflow({ ${key} }) of @nestjs/workflows has no 1:1 durable option; see the migration guide`,
        );
    }
    return `${this.leading(node)}@Workflow({ ${fields.join(', ')} })`;
  }

  /** Statement-level rewrites: `ctx.fail(msg)` and `ctx.setStatus(x)`. */
  private statement(node: Node): string | undefined {
    if (!Node.isExpressionStatement(node)) return undefined;
    const expr = node.getExpression();
    if (!Node.isCallExpression(expr)) return undefined;
    const callee = expr.getExpression();
    if (
      !Node.isPropertyAccessExpression(callee) ||
      !this.typedAs(callee.getExpression(), 'WorkflowContext')
    ) {
      return undefined;
    }
    const ctx = this.r(callee.getExpression());
    const args = expr.getArguments().map((a) => this.r(a));
    if (callee.getName() === 'fail') {
      this.usedCore.add('FatalError');
      return `${this.leading(node)}throw new FatalError(${args.join(', ')});`;
    }
    if (callee.getName() === 'setStatus') {
      return `${this.leading(node)}await ${ctx}.setEvent('status', ${args[0] ?? 'undefined'});`;
    }
    return undefined;
  }

  private call(node: CallExpression): string | undefined {
    const callee = node.getExpression();
    if (
      this.officialName(
        Node.isPropertyAccessExpression(callee) ? callee.getExpression() : callee,
      ) === 'WorkflowsModule'
    ) {
      if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'forRoot') {
        this.usedDurable.add('DurableModule');
        this.todo(
          'give DurableModule a state store and a transport (e.g. a store adapter + EventEmitterTransport); the official worker/journal/codec options have durable counterparts in the migration guide',
        );
        return `${this.leading(node)}DurableModule.forRoot({ store, transport })`;
      }
      return undefined;
    }
    if (!Node.isPropertyAccessExpression(callee)) return undefined;
    const receiver = callee.getExpression();
    const method = callee.getName();
    const args = node.getArguments();
    const lead = this.leading(node);
    if (this.typedAs(receiver, 'WorkflowContext'))
      return this.ctxCall(node, this.r(receiver), method, args, lead);
    if (this.typedAs(receiver, 'WorkflowClient'))
      return this.clientCall(this.r(receiver), method, args, lead);
    return undefined;
  }

  private ctxCall(
    node: CallExpression,
    ctx: string,
    method: string,
    args: Node[],
    lead: string,
  ): string | undefined {
    const awaited = Node.isAwaitExpression(node.getParent());
    const typeArgs = node.getTypeArguments();
    const generic = typeArgs.length > 0 ? `<${this.r(typeArgs[0] as Node)}>` : '';
    const value = (expr: string) => (awaited ? expr : `(await ${expr})`);
    switch (method) {
      case 'step': {
        const [name, fn, options] = args;
        if (!name || !fn) return undefined;
        let fnText = this.r(fn);
        if ((Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) && !fn.isAsync())
          fnText = `async ${fnText}`;
        if (
          (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) &&
          fn.getParameters().length > 0
        ) {
          this.todo(
            "durable's step function receives a StepLogger, not { idempotencyKey, attempt, signal, heartbeat }: derive an idempotency key from ctx.runId + the step name",
          );
        }
        const out = options ? this.stepOptions(options) : '';
        return `${lead}${ctx}.localStep${generic}(${this.r(name)}, ${fnText}${out})`;
      }
      case 'sleep': {
        const [, duration] = args;
        if (args.length !== 2 || !duration) return undefined;
        const until = props(duration)?.get('until');
        if (until) return `${lead}${ctx}.sleepUntil(${this.r(until)})`;
        return `${lead}${ctx}.sleep(${this.r(duration)})`;
      }
      case 'waitForSignal': {
        const [, signal, options] = args;
        if (args.length < 2 || !signal) return undefined;
        const opts = props(options);
        if (options && !opts) {
          this.todo('waitForSignal options could not be read; map them by hand');
          return undefined;
        }
        const token = this.token(signal, opts?.get('key'));
        if (!token) return undefined;
        const fields: string[] = [];
        const timeout = opts?.get('timeout');
        if (timeout) {
          const ms = literalMs(timeout);
          if (ms === undefined)
            this.todo('waitForSignal timeout is not a literal: pass { timeoutMs } in ms');
          fields.push(`timeoutMs: ${ms ?? this.r(timeout)}`);
          this.todo(
            'on timeout durable THROWS SignalTimeoutError (from @dudousxd/nestjs-durable-core) where @nestjs/workflows resolved null: wrap this in try/catch',
          );
        }
        if (opts?.has('match'))
          this.todo(
            'waitForSignal `match` has no durable equivalent: filter in the workflow and wait again, or use ctx.waitForEvent(name, { match })',
          );
        return `${lead}${ctx}.waitForSignal${generic}(${token}${fields.length ? `, { ${fields.join(', ')} }` : ''})`;
      }
      case 'executeChild':
      case 'startChild': {
        const [workflow, input, options] = args;
        if (!workflow) return undefined;
        const fields: string[] = [];
        for (const [key, v] of props(options) ?? []) {
          if (key === 'id') fields.push(`childId: ${this.r(v)}`);
          else if (key === 'parentClose') fields.push(`parentClose: ${this.r(v)}`);
          else if (key === 'priority') fields.push(`priority: ${this.r(v)}`);
          else if (key === 'version') fields.push(`version: '${v.getText().replace(/['"]/g, '')}'`);
          else
            this.todo(`${method}({ ${key} }) has no durable child option; see the migration guide`);
        }
        if (options && !props(options))
          this.todo(`${method} options could not be read; map them by hand`);
        if (method === 'startChild' && !this.onlyRacedInWaitForAny(node)) {
          this.todo(
            "durable's ctx.startChild resolves the child's run id, not a handle: join it with ctx.child(workflow, input, { childId: id }) or ctx.waitForRun(id); in ctx.waitForAny it is ctx.childWait(id) (done for you)",
          );
        }
        const target = method === 'executeChild' ? 'child' : 'startChild';
        const rest = [
          input ? this.r(input) : 'undefined',
          ...(fields.length ? [`{ ${fields.join(', ')} }`] : []),
        ];
        return `${lead}${ctx}.${target}(${this.r(workflow)}, ${rest.join(', ')})`;
      }
      case 'now':
        return lead + value(`${ctx}.now()`);
      case 'random':
        return lead + value(`${ctx}.sideEffect(() => Math.random())`);
      case 'uuid':
        return lead + value(`${ctx}.sideEffect(() => crypto.randomUUID())`);
      case 'signalWait': {
        const [signal, options] = args;
        if (!signal) return undefined;
        const opts = props(options);
        if (options && !opts) {
          this.todo('signalWait options could not be read; map them by hand');
          return undefined;
        }
        const token = this.token(signal, opts?.get('key'));
        if (!token) return undefined;
        if (opts?.has('match'))
          this.todo(
            'signalWait `match` has no durable equivalent: give the matching signals their own token (key)',
          );
        return `${lead}${ctx}.signalWait${generic}(${token})`;
      }
      case 'waitForAny':
        return this.waitForAny(ctx, args, generic, lead);
      case 'commit':
        this.todo(
          'durable has no ctx.commit(): compensations of the steps before it still run on failure; restructure the saga (e.g. end it in a child workflow)',
        );
        return undefined;
      default:
        return undefined;
    }
  }

  /**
   * `ctx.waitForAny(name, { … })`: the same call, with every child handle among the conditions
   * wrapped in `ctx.childWait(…)` (durable's `startChild` resolves a run id, not a handle).
   * `ctx.signalWait` / `ctx.timer` conditions are rewritten where they stand.
   */
  private waitForAny(ctx: string, args: Node[], generic: string, lead: string): string | undefined {
    const [name, conditions] = args;
    if (!name || !conditions) return undefined;
    if (!Node.isObjectLiteralExpression(conditions)) {
      this.todo(
        'waitForAny conditions are not an object literal: wrap each child handle in ctx.childWait(handle)',
      );
      return undefined;
    }
    const start = conditions.getStart();
    let text = conditions.getText();
    const edits: Array<{ from: number; to: number; text: string }> = [];
    for (const p of conditions.getProperties()) {
      const value = Node.isPropertyAssignment(p)
        ? p.getInitializerOrThrow()
        : Node.isShorthandPropertyAssignment(p)
          ? p.getNameNode()
          : undefined;
      if (!value) {
        this.todo(
          'waitForAny conditions with a spread: wrap each child handle in ctx.childWait(handle)',
        );
        return undefined;
      }
      const kind = this.conditionKind(value);
      if (kind === undefined) {
        this.todo(
          `could not tell whether \`${value.getText()}\` is a condition or a child handle: wrap a handle in ${ctx}.childWait(handle)`,
        );
      }
      const rendered = kind === 'handle' ? `${ctx}.childWait(${this.r(value)})` : this.r(value);
      if (Node.isShorthandPropertyAssignment(p)) {
        if (kind === 'handle') {
          edits.push({ from: p.getStart(), to: p.getEnd(), text: `${p.getName()}: ${rendered}` });
        }
      } else {
        edits.push({ from: value.getStart(), to: value.getEnd(), text: rendered });
      }
    }
    for (const edit of edits.sort((a, b) => b.from - a.from)) {
      text = text.slice(0, edit.from - start) + edit.text + text.slice(edit.to - start);
    }
    return `${lead}${ctx}.waitForAny${generic}(${this.r(name)}, ${text})`;
  }

  /** Whether a `waitForAny` condition is a condition call, a child handle, or can't be told. */
  private conditionKind(node: Node): 'condition' | 'handle' | undefined {
    const expr = Node.isAwaitExpression(node) ? node.getExpression() : node;
    if (Node.isCallExpression(expr)) {
      const callee = expr.getExpression();
      if (
        Node.isPropertyAccessExpression(callee) &&
        this.typedAs(callee.getExpression(), 'WorkflowContext')
      ) {
        const method = callee.getName();
        if (method === 'signalWait' || method === 'timer') return 'condition';
        if (method === 'startChild') return 'handle';
      }
      return undefined;
    }
    if (!Node.isIdentifier(expr)) return undefined;
    // `{ child }`: the shorthand's own symbol is the property; the variable is its value symbol.
    const owner = expr.getParent();
    const symbol = Node.isShorthandPropertyAssignment(owner)
      ? owner.getValueSymbol()
      : expr.getSymbol();
    for (const decl of symbol?.getDeclarations() ?? []) {
      if (!Node.isVariableDeclaration(decl) && !Node.isParameterDeclaration(decl)) continue;
      const typeNode = decl.getTypeNode();
      if (typeNode && Node.isTypeReference(typeNode)) {
        const type = this.officialName(typeNode.getTypeName());
        if (type === 'ChildWorkflowHandle') return 'handle';
        if (type === 'WorkflowCondition') return 'condition';
      }
      const init = Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
      if (init) return this.conditionKind(init);
    }
    return undefined;
  }

  /**
   * Whether the handle `ctx.startChild(…)` resolves is only ever used as a `waitForAny` condition
   * (assigned to a variable whose every reference sits in a `waitForAny` conditions object), so the
   * handle → id change needs nothing more than the `ctx.childWait` wrapping done there.
   */
  private onlyRacedInWaitForAny(call: CallExpression): boolean {
    const awaited = call.getParent();
    if (!Node.isAwaitExpression(awaited)) return false;
    // A condition of its own: `{ c: await ctx.startChild(…) }`.
    if (this.isWaitForAnyCondition(awaited)) return true;
    const decl = awaited.getParent();
    if (!Node.isVariableDeclaration(decl)) return false;
    const refs = decl
      .getNameNode()
      .asKind(SyntaxKind.Identifier)
      ?.findReferencesAsNodes()
      .filter((ref) => ref !== decl.getNameNode());
    if (!refs || refs.length === 0) return false;
    return refs.every((ref) => this.isWaitForAnyCondition(ref));
  }

  /** Whether `node` is the value of a property of a `waitForAny` conditions object. */
  private isWaitForAnyCondition(node: Node): boolean {
    const owner = node.getParent();
    const object = Node.isShorthandPropertyAssignment(owner)
      ? owner.getParent()
      : Node.isPropertyAssignment(owner) && owner.getInitializer() === node
        ? owner.getParent()
        : undefined;
    const call = object?.getParent();
    const callee = Node.isCallExpression(call) ? call.getExpression() : undefined;
    return Node.isPropertyAccessExpression(callee) && callee.getName() === 'waitForAny';
  }

  /** `<signal>` or `<signal>:<key>` as a durable signal token expression. */
  private token(signal: Node, key: Node | undefined): string | undefined {
    const literal = Node.isStringLiteral(signal) || Node.isNoSubstitutionTemplateLiteral(signal);
    if (!literal) {
      this.todo(
        'the signal is a WorkflowSignal object: durable signals are string tokens, use its name',
      );
      return undefined;
    }
    const name = signal.getLiteralValue();
    if (!key) return this.r(signal);
    return Node.isStringLiteral(key)
      ? `'${name}:${key.getLiteralValue()}'`
      : `\`${name}:\${${this.r(key)}}\``;
  }

  private stepOptions(options: Node): string {
    const opts = props(options);
    if (!opts) {
      this.todo(
        'step options could not be read; map them by hand (retry → retries, timeout → timeoutMs)',
      );
      return `, ${this.r(options)}`;
    }
    const fields: string[] = [];
    for (const [key, v] of opts) {
      if (key === 'retry') {
        if (Node.isNumericLiteral(v)) fields.push(`retries: ${v.getText()}`);
        else if (v.getKind() === SyntaxKind.FalseKeyword) fields.push('retries: 1');
        else {
          this.todo(
            'step retry object: map attempts → retries, backoff → backoff/backoffMs/backoffMaxMs',
          );
          fields.push(`retry: ${this.r(v)}`);
        }
      } else if (key === 'timeout') {
        const ms = literalMs(v);
        if (ms === undefined) this.todo('step timeout is not a literal: pass timeoutMs in ms');
        fields.push(`timeoutMs: ${ms ?? this.r(v)}`);
      } else if (key === 'compensate') {
        if (
          (Node.isArrowFunction(v) || Node.isFunctionExpression(v)) &&
          v.getParameters().length > 0
        ) {
          this.todo(
            "durable's compensate takes no arguments (not (result, ctx)): capture the step's result in a variable",
          );
        }
        fields.push(`compensate: ${this.r(v)}`);
      } else {
        this.todo(`step option \`${key}\` has no durable equivalent; see the migration guide`);
        fields.push(`${key}: ${this.r(v)}`);
      }
    }
    return `, { ${fields.join(', ')} }`;
  }

  private clientCall(
    client: string,
    method: string,
    args: Node[],
    lead: string,
  ): string | undefined {
    switch (method) {
      case 'start': {
        const [workflow, input, options] = args;
        if (!workflow) return undefined;
        const opts = props(options);
        if (options && !opts) {
          this.todo('start options could not be read; pass the run id as the 3rd argument');
          return undefined;
        }
        for (const key of opts?.keys() ?? []) {
          if (key === 'transaction')
            this.todo(
              'transactional start: use DurableOutbox.start(tx, …) from @dudousxd/nestjs-durable/outbox',
            );
          else if (key !== 'id')
            this.todo(
              `start({ ${key} }) maps to durable StartOptions (4th argument) by hand; see the migration guide`,
            );
        }
        const id = opts?.get('id');
        const parts = [
          this.r(workflow),
          input ? this.r(input) : 'undefined',
          ...(id ? [this.r(id)] : []),
        ];
        return `${lead}${client}.start(${parts.join(', ')})`;
      }
      case 'signal': {
        const [signal, payload, options] = args;
        if (!signal) return undefined;
        const opts = props(options);
        const token = this.token(signal, opts?.get('key'));
        if (!token) return undefined;
        if (opts?.has('transaction'))
          this.todo(
            'transactional signal: use DurableOutbox.signal(tx, …) from @dudousxd/nestjs-durable/outbox',
          );
        const id = opts?.get('id');
        return `${lead}${client}.signal(${token}, ${payload ? this.r(payload) : 'undefined'}${id ? `, { id: ${this.r(id)} }` : ''})`;
      }
      case 'result': {
        const [id] = args;
        if (!id) return undefined;
        this.todo(
          'waitForRun resolves { status, output, error } (not the output), and does not throw WorkflowFailedError: check status',
        );
        return `${lead}${client}.waitForRun(${this.r(id)}, { until: 'terminal' })`;
      }
      case 'getStatus':
      case 'list':
      case 'cancel':
      case 'terminate':
      case 'retry':
      case 'delete':
      case 'purge':
      case 'startAndWait':
        this.todo(
          `WorkflowClient.${method} → see the migration guide (WorkflowEngine / RunGateway: getRun, listRuns, cancel(id, { compensate }), retry, deleteRun, retention)`,
        );
        return undefined;
      default:
        return undefined;
    }
  }

  private importHeader(): string {
    const lines: string[] = [];
    const left = [...this.imported.values()].filter((name) => !IMPORT_MAP[name]);
    const fmt = (names: Set<string>) => {
      const values = [...names].filter((n) => !n.startsWith('type ')).sort();
      const types = [...names].filter((n) => n.startsWith('type ')).sort();
      return [...types, ...values].join(', ');
    };
    if (this.usedCore.size) lines.push(`import { ${fmt(this.usedCore)} } from '${CORE}';`);
    if (this.usedDurable.size) lines.push(`import { ${fmt(this.usedDurable)} } from '${DURABLE}';`);
    if (left.length) {
      this.total += 1;
      lines.push(
        `// ${TODO}: still imported from @nestjs/workflows, no durable equivalent: ${left.join(', ')}`,
      );
      lines.push(`import { ${left.join(', ')} } from '${OFFICIAL}';`);
    }
    if (lines.length === 0) return '';
    // Placed where the first official import was.
    return lines.join('\n');
  }
}

/** Migrate one file's text. `fileName` only matters for TSX parsing. */
export function migrateSource(text: string, fileName = 'file.ts'): MigrationResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { experimentalDecorators: true },
  });
  const file = project.createSourceFile(fileName, text);
  const migration = new Migration(file);
  if (!migration.applies) return { text, changed: false, todos: 0 };
  return migration.run();
}

export interface MigrateFilesResult {
  files: Array<{ path: string; changed: boolean; todos: number }>;
}

/** Migrate every file matching `globs` in place (or not, with `dryRun`). */
export function migrateFiles(globs: string[], opts: { dryRun?: boolean } = {}): MigrateFilesResult {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const files = project.addSourceFilesAtPaths(globs);
  const out: MigrateFilesResult['files'] = [];
  for (const file of files) {
    const result = migrateSource(file.getFullText(), file.getBaseName());
    if (result.changed && !opts.dryRun) {
      file.replaceWithText(result.text);
      file.saveSync();
    }
    out.push({ path: file.getFilePath(), changed: result.changed, todos: result.todos });
  }
  return { files: out };
}
