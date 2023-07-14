/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { SpanStatusCode, context } from '@opentelemetry/api';
import contextAsyncHooksPkg from '@opentelemetry/context-async-hooks';
import httpInstrumentationPkg from '@opentelemetry/instrumentation-http';
import sdkTraceBasePkg from '@opentelemetry/sdk-trace-base';
import sdkTraceNodePkg from '@opentelemetry/sdk-trace-node';
import semanticConventionsPkg from '@opentelemetry/semantic-conventions';
import * as assert from 'assert';
import { URL } from 'url';
import fastifyInstrumentationPkg from '../build/src/index.js';
import { ANONYMOUS_NAME } from '../build/src/instrumentation.js';

const { AsyncHooksContextManager } = contextAsyncHooksPkg;
const { AttributeNames, FastifyInstrumentation } = fastifyInstrumentationPkg;
const { HttpInstrumentation } = httpInstrumentationPkg;
const { InMemorySpanExporter, SimpleSpanProcessor } = sdkTraceBasePkg;
const { NodeTracerProvider } = sdkTraceNodePkg;
const { SemanticAttributes } = semanticConventionsPkg;

const httpInstrumentation = new HttpInstrumentation();
const instrumentation = new FastifyInstrumentation();
const contextManager = new AsyncHooksContextManager().enable();
const memoryExporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider();
const spanProcessor = new SimpleSpanProcessor(memoryExporter);
instrumentation.setTracerProvider(provider);
httpInstrumentation.setTracerProvider(provider);
context.setGlobalContextManager(contextManager);

provider.addSpanProcessor(spanProcessor);
instrumentation.enable();
httpInstrumentation.enable();

const fastifyExpress = await import('@fastify/express');
const http = await import('http');

const httpRequest = {
  get: options => {
    return new Promise((resolve, reject) => {
      return http.get(options, resp => {
        let data = '';
        resp.on('data', chunk => {
          data += chunk;
        });
        resp.on('end', () => {
          resolve(data);
        });
        resp.on('error', err => {
          reject(err);
        });
      });
    });
  },
};

const assertRootContextActive = () => {
  // Asserting the context.active() to strictly equal ROOT_CONTEXT doesn't
  // always work because of the linking and dep resolution.
  // Specially in our CI environment there can be multiple instances to
  // different @opentelemetry/api and thus ROOT_CONTEXTs in the tree.
  assert.strictEqual(context.active()['_currentContext'].size, 0);
};

function getSpans() {
  const spans = memoryExporter.getFinishedSpans().filter(s => {
    return (
      s.instrumentationLibrary.name === '@opentelemetry/instrumentation-fastify'
    );
  });
  return spans;
}

describe('fastify', () => {
  let PORT;
  let app;

  async function startServer() {
    const address = await app.listen({ port: 0 });
    const url = new URL(address);
    PORT = parseInt(url.port, 10);
  }

  function setup(fastify) {
    instrumentation.enable();
    app = fastify();
    app.register(fastifyExpress);
  }

  afterEach(async () => {
    if (app.server.address()) {
      await app.close();
    }

    contextManager.disable();
    contextManager.enable();
    memoryExporter.reset();
    instrumentation.disable();
  });

  describe('given that the default export is being used', () => {
    beforeEach(async () => {
      const { default: fastify } = await import('fastify');
      setup(fastify);
    });

    describe('when fastify is disabled', () => {
      it('should not generate any spans', async () => {
        instrumentation.disable();
        app.get('/test', (req, res) => {
          res.send('OK');
        });

        await startServer();
        await httpRequest.get(`http://localhost:${PORT}/test`);

        const spans = getSpans();
        assert.strictEqual(spans.length, 0); // http instrumentation only
      });
    });

    describe('when fastify is enabled', () => {
      it('should generate span for anonymous middleware', async () => {
        app.get('/test', (req, res) => {
          res.send('OK');
        });

        await startServer();
        await httpRequest.get(`http://localhost:${PORT}/test`);

        const spans = memoryExporter.getFinishedSpans();
        console.log(spans);
        assert.strictEqual(spans.length, 5);
        const span = spans[2];
        assert.deepStrictEqual(span.attributes, {
          'fastify.type': 'request_handler',
          'plugin.name': 'fastify -> @fastify/express',
          [SemanticAttributes.HTTP_ROUTE]: '/test',
        });
        assert.strictEqual(span.name, `request handler - ${ANONYMOUS_NAME}`);
        const baseSpan = spans[1];
        assert.strictEqual(span.parentSpanId, baseSpan.spanContext().spanId);
      });

      it('should generate span for named handler', async () => {
        // eslint-disable-next-line prefer-arrow-callback
        app.get('/test', function namedHandler(req, res) {
          res.send('OK');
        });

        await startServer();
        await httpRequest.get(`http://localhost:${PORT}/test`);

        const spans = memoryExporter.getFinishedSpans();
        assert.strictEqual(spans.length, 5);
        const span = spans[2];
        assert.deepStrictEqual(span.attributes, {
          'fastify.type': 'request_handler',
          'fastify.name': 'namedHandler',
          'plugin.name': 'fastify -> @fastify/express',
          [SemanticAttributes.HTTP_ROUTE]: '/test',
        });
        assert.strictEqual(span.name, 'request handler - namedHandler');

        const baseSpan = spans[1];
        assert.strictEqual(span.parentSpanId, baseSpan.spanContext().spanId);
      });

      describe('when subsystem is registered', () => {
        beforeEach(async () => {
          httpInstrumentation.enable();

          async function subsystem(fastify) {
            fastify.addHook('onRequest', async (req, res, next) => {
              next();
            });
            fastify.use((req, res, next) => {
              next();
            });
            // eslint-disable-next-line prefer-arrow-callback
            fastify.get('/test/:id', function foo(req, res) {
              res.send('OK');
            });
            fastify.get('/test-error', () => {
              throw Error('foo');
            });
          }

          app.register(subsystem);

          await startServer();
          await httpRequest.get(`http://localhost:${PORT}/test/1`);

          assert.strictEqual(getSpans().length, 4);
        });

        it('should change name for parent http route', async () => {
          const spans = memoryExporter.getFinishedSpans();

          assert.strictEqual(spans.length, 6);
          const changedRootSpan = spans[4];
          const span = spans[3];
          assert.strictEqual(changedRootSpan.name, 'GET /test/:id');
          assert.strictEqual(span.name, 'request handler - foo');
          assert.strictEqual(span.parentSpanId, spans[2].spanContext().spanId);
        });

        it('should create span for fastify express runConnect', async () => {
          const spans = memoryExporter.getFinishedSpans();

          assert.strictEqual(spans.length, 6);
          const baseSpan = spans[0];
          const span = spans[1];
          assert.strictEqual(span.name, 'middleware - runConnect');
          assert.deepStrictEqual(span.attributes, {
            'fastify.type': 'middleware',
            'plugin.name': 'fastify -> @fastify/express',
            'hook.name': 'onRequest',
          });

          assert.strictEqual(span.parentSpanId, baseSpan.spanContext().spanId);
        });

        it('should create span for fastify express for enhanceRequest', async () => {
          const spans = memoryExporter.getFinishedSpans();

          assert.strictEqual(spans.length, 6);
          const baseSpan = spans[4];
          const span = spans[0];
          assert.strictEqual(span.name, 'middleware - enhanceRequest');
          assert.deepStrictEqual(span.attributes, {
            'fastify.type': 'middleware',
            'plugin.name': 'fastify -> @fastify/express',
            'hook.name': 'onRequest',
          });

          assert.strictEqual(span.parentSpanId, baseSpan.spanContext().spanId);
        });

        it('should create span for request', async () => {
          const spans = memoryExporter.getFinishedSpans();

          assert.strictEqual(spans.length, 6);
          const baseSpan = spans[2];
          const span = spans[3];
          assert.strictEqual(span.name, 'request handler - foo');
          assert.deepStrictEqual(span.attributes, {
            'plugin.name': 'subsystem',
            'fastify.type': 'request_handler',
            'fastify.name': 'foo',
            'http.route': '/test/:id',
          });

          assert.strictEqual(span.parentSpanId, baseSpan.spanContext().spanId);
        });

        it('should update http.route for http span', async () => {
          const spans = memoryExporter.getFinishedSpans();

          assert.strictEqual(spans.length, 6);
          const span = spans[4];
          assert.strictEqual(span.attributes['http.route'], '/test/:id');
        });

        it('should create span for subsystem anonymous middleware', async () => {
          const spans = memoryExporter.getFinishedSpans();

          assert.strictEqual(spans.length, 6);
          const baseSpan = spans[1];
          const span = spans[2];
          assert.strictEqual(span.name, `middleware - ${ANONYMOUS_NAME}`);
          assert.deepStrictEqual(span.attributes, {
            'fastify.type': 'middleware',
            'plugin.name': 'subsystem',
            'hook.name': 'onRequest',
          });

          assert.strictEqual(span.parentSpanId, baseSpan.spanContext().spanId);
        });

        it('should update span with error that was raised', async () => {
          memoryExporter.reset();
          await httpRequest.get(`http://localhost:${PORT}/test-error`);
          const spans = memoryExporter.getFinishedSpans();

          assert.strictEqual(spans.length, 6);
          const span = spans[3];
          assert.strictEqual(span.name, 'request handler - anonymous');
          assert.deepStrictEqual(span.status, {
            code: SpanStatusCode.ERROR,
            message: 'foo',
          });
          assert.deepStrictEqual(span.attributes, {
            'fastify.type': 'request_handler',
            'plugin.name': 'subsystem',
            'http.route': '/test-error',
          });
        });
      });

      describe('spans context', () => {
        describe('hook callback', () => {
          it('span should end upon done invocation', async () => {
            let hookDone;
            const hookExecutedPromise = new Promise(resolve => {
              app.addHook('onRequest', (_req, _reply, done) => {
                hookDone = done;
                resolve();
              });
            });
            app.get('/test', (_req, reply) => {
              reply.send('request ended in handler');
            });
            await startServer();
            httpRequest.get(`http://localhost:${PORT}/test`);
            await hookExecutedPromise;

            // done was not yet called from the hook, so it should not end the span
            const preDoneSpans = getSpans().filter(
              s =>
                !s.attributes[AttributeNames.PLUGIN_NAME] ||
                s.attributes[AttributeNames.PLUGIN_NAME] === 'fastify'
            );
            assert.strictEqual(preDoneSpans.length, 0);
            hookDone();
            const postDoneSpans = getSpans().filter(
              s =>
                !s.attributes[AttributeNames.PLUGIN_NAME] ||
                s.attributes[AttributeNames.PLUGIN_NAME] === 'fastify'
            );
            assert.strictEqual(postDoneSpans.length, 1);
          });

          it('span should end when calling reply.send from hook', async () => {
            app.addHook('onRequest', (_req, reply, _done) => {
              reply.send('request ended prematurely in hook');
            });
            app.get('/test', (_req, _reply) => {
              throw Error(
                'handler should not be executed as request is ended in onRequest hook'
              );
            });
            await startServer();
            await httpRequest.get(`http://localhost:${PORT}/test`);
            const spans = getSpans().filter(
              s =>
                !s.attributes[AttributeNames.PLUGIN_NAME] ||
                s.attributes[AttributeNames.PLUGIN_NAME] === 'fastify'
            );
            assert.strictEqual(spans.length, 1);
          });
        });
      });

      describe('application hooks', () => {
        afterEach(() => {
          const spans = getSpans();
          assert.strictEqual(spans.length, 0);
        });

        it('onRoute not instrumented', async () => {
          app.addHook('onRoute', () => {
            assertRootContextActive();
          });
          // add a route to trigger the 'onRoute' hook
          app.get('/test', (_req, reply) => {
            reply.send('OK');
          });

          await startServer();
        });

        it('onRegister is not instrumented', async () => {
          app.addHook('onRegister', () => {
            assertRootContextActive();
          });
          // register a plugin to trigger 'onRegister' hook
          app.register((fastify, options, done) => {
            done();
          });

          await startServer();
        });

        it('onReady is not instrumented', async () => {
          app.addHook('onReady', () => {
            assertRootContextActive();
          });

          await startServer();
        });

        it('onClose is not instrumented', async () => {
          app.addHook('onClose', () => {
            assertRootContextActive();
          });

          await startServer();
        });
      });

      describe('using requestHook in config', () => {
        it('calls requestHook provided function when set in config', async () => {
          const requestHook = (span, info) => {
            span.setAttribute(
              SemanticAttributes.HTTP_METHOD,
              info.request.method
            );
          };

          instrumentation.setConfig({
            ...instrumentation.getConfig(),
            requestHook,
          });

          app.get('/test', (req, res) => {
            res.send('OK');
          });

          await startServer();
          await httpRequest.get(`http://localhost:${PORT}/test`);

          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 5);
          const span = spans[2];
          assert.deepStrictEqual(span.attributes, {
            'fastify.type': 'request_handler',
            'plugin.name': 'fastify -> @fastify/express',
            [SemanticAttributes.HTTP_ROUTE]: '/test',
            [SemanticAttributes.HTTP_METHOD]: 'GET',
          });
        });

        it('does not propagate an error from a requestHook that throws exception', async () => {
          const requestHook = (span, info) => {
            span.setAttribute(
              SemanticAttributes.HTTP_METHOD,
              info.request.method
            );

            throw Error('error thrown in requestHook');
          };

          instrumentation.setConfig({
            ...instrumentation.getConfig(),
            requestHook,
          });

          app.get('/test', (req, res) => {
            res.send('OK');
          });

          await startServer();
          await httpRequest.get(`http://localhost:${PORT}/test`);

          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 5);
          const span = spans[2];
          assert.deepStrictEqual(span.attributes, {
            'fastify.type': 'request_handler',
            'plugin.name': 'fastify -> @fastify/express',
            [SemanticAttributes.HTTP_ROUTE]: '/test',
            [SemanticAttributes.HTTP_METHOD]: 'GET',
          });
        });
      });
    });
  });
  describe('given that the named export is being used', () => {
    beforeEach(async () => {
      const { fastify } = await import('fastify');
      setup(fastify);
    });

    describe('when fastify is disabled', () => {
      it('should not generate any spans', async () => {
        instrumentation.disable();
        app.get('/test', (req, res) => {
          res.send('OK');
        });

        await startServer();
        await httpRequest.get(`http://localhost:${PORT}/test`);

        const spans = getSpans();
        assert.strictEqual(spans.length, 0); // http instrumentation only
      });
    });

    describe('when fastify is enabled', () => {
      it('should generate span for anonymous middleware', async () => {
        app.get('/test', (req, res) => {
          res.send('OK');
        });

        await startServer();
        await httpRequest.get(`http://localhost:${PORT}/test`);

        const spans = memoryExporter.getFinishedSpans();
        assert.strictEqual(spans.length, 5);
        const span = spans[2];
        assert.deepStrictEqual(span.attributes, {
          'fastify.type': 'request_handler',
          'plugin.name': 'fastify -> @fastify/express',
          'http.method': 'GET',
          [SemanticAttributes.HTTP_ROUTE]: '/test',
        });
        assert.strictEqual(span.name, `request handler - ${ANONYMOUS_NAME}`);
        const baseSpan = spans[1];
        assert.strictEqual(span.parentSpanId, baseSpan.spanContext().spanId);
      });

      it('should generate span for named handler', async () => {
        // eslint-disable-next-line prefer-arrow-callback
        app.get('/test', function namedHandler(req, res) {
          res.send('OK');
        });

        await startServer();
        await httpRequest.get(`http://localhost:${PORT}/test`);

        const spans = memoryExporter.getFinishedSpans();
        assert.strictEqual(spans.length, 5);
        const span = spans[2];
        assert.deepStrictEqual(span.attributes, {
          'fastify.type': 'request_handler',
          'fastify.name': 'namedHandler',
          'plugin.name': 'fastify -> @fastify/express',
          'http.method': 'GET',
          [SemanticAttributes.HTTP_ROUTE]: '/test',
        });
        assert.strictEqual(span.name, 'request handler - namedHandler');

        const baseSpan = spans[1];
        assert.strictEqual(span.parentSpanId, baseSpan.spanContext().spanId);
      });

      describe('when subsystem is registered', () => {
        beforeEach(async () => {
          httpInstrumentation.enable();

          async function subsystem(fastify) {
            fastify.addHook('onRequest', async (req, res, next) => {
              next();
            });
            fastify.use((req, res, next) => {
              next();
            });
            // eslint-disable-next-line prefer-arrow-callback
            fastify.get('/test/:id', function foo(req, res) {
              res.send('OK');
            });
            fastify.get('/test-error', () => {
              throw Error('foo');
            });
          }

          app.register(subsystem);

          await startServer();
          await httpRequest.get(`http://localhost:${PORT}/test/1`);

          assert.strictEqual(getSpans().length, 4);
        });

        it('should change name for parent http route', async () => {
          const spans = memoryExporter.getFinishedSpans();

          assert.strictEqual(spans.length, 6);
          const changedRootSpan = spans[4];
          const span = spans[3];
          assert.strictEqual(changedRootSpan.name, 'GET /test/:id');
          assert.strictEqual(span.name, 'request handler - foo');
          assert.strictEqual(span.parentSpanId, spans[2].spanContext().spanId);
        });

        it('should create span for fastify express runConnect', async () => {
          const spans = memoryExporter.getFinishedSpans();

          assert.strictEqual(spans.length, 6);
          const baseSpan = spans[0];
          const span = spans[1];
          assert.strictEqual(span.name, 'middleware - runConnect');
          assert.deepStrictEqual(span.attributes, {
            'fastify.type': 'middleware',
            'plugin.name': 'fastify -> @fastify/express',
            'hook.name': 'onRequest',
          });

          assert.strictEqual(span.parentSpanId, baseSpan.spanContext().spanId);
        });

        it('should create span for fastify express for enhanceRequest', async () => {
          const spans = memoryExporter.getFinishedSpans();

          assert.strictEqual(spans.length, 6);
          const baseSpan = spans[4];
          const span = spans[0];
          assert.strictEqual(span.name, 'middleware - enhanceRequest');
          assert.deepStrictEqual(span.attributes, {
            'fastify.type': 'middleware',
            'plugin.name': 'fastify -> @fastify/express',
            'hook.name': 'onRequest',
          });

          assert.strictEqual(span.parentSpanId, baseSpan.spanContext().spanId);
        });

        it('should create span for request', async () => {
          const spans = memoryExporter.getFinishedSpans();

          assert.strictEqual(spans.length, 6);
          const baseSpan = spans[2];
          const span = spans[3];
          assert.strictEqual(span.name, 'request handler - foo');
          assert.deepStrictEqual(span.attributes, {
            'plugin.name': 'subsystem',
            'fastify.type': 'request_handler',
            'fastify.name': 'foo',
            'http.route': '/test/:id',
            'http.method': 'GET',
          });

          assert.strictEqual(span.parentSpanId, baseSpan.spanContext().spanId);
        });

        it('should update http.route for http span', async () => {
          const spans = memoryExporter.getFinishedSpans();

          assert.strictEqual(spans.length, 6);
          const span = spans[4];
          assert.strictEqual(span.attributes['http.route'], '/test/:id');
        });

        it('should create span for subsystem anonymous middleware', async () => {
          const spans = memoryExporter.getFinishedSpans();

          assert.strictEqual(spans.length, 6);
          const baseSpan = spans[1];
          const span = spans[2];
          assert.strictEqual(span.name, `middleware - ${ANONYMOUS_NAME}`);
          assert.deepStrictEqual(span.attributes, {
            'fastify.type': 'middleware',
            'plugin.name': 'subsystem',
            'hook.name': 'onRequest',
          });

          assert.strictEqual(span.parentSpanId, baseSpan.spanContext().spanId);
        });

        it('should update span with error that was raised', async () => {
          memoryExporter.reset();
          await httpRequest.get(`http://localhost:${PORT}/test-error`);
          const spans = memoryExporter.getFinishedSpans();

          assert.strictEqual(spans.length, 6);
          const span = spans[3];
          assert.strictEqual(span.name, 'request handler - anonymous');
          assert.deepStrictEqual(span.status, {
            code: SpanStatusCode.ERROR,
            message: 'foo',
          });
          assert.deepStrictEqual(span.attributes, {
            'fastify.type': 'request_handler',
            'plugin.name': 'subsystem',
            'http.route': '/test-error',
            'http.method': 'GET',
          });
        });
      });

      describe('spans context', () => {
        describe('hook callback', () => {
          it('span should end upon done invocation', async () => {
            let hookDone;
            const hookExecutedPromise = new Promise(resolve => {
              app.addHook('onRequest', (_req, _reply, done) => {
                hookDone = done;
                resolve();
              });
            });
            app.get('/test', (_req, reply) => {
              reply.send('request ended in handler');
            });
            await startServer();
            httpRequest.get(`http://localhost:${PORT}/test`);
            await hookExecutedPromise;

            // done was not yet called from the hook, so it should not end the span
            const preDoneSpans = getSpans().filter(
              s =>
                !s.attributes[AttributeNames.PLUGIN_NAME] ||
                s.attributes[AttributeNames.PLUGIN_NAME] === 'fastify'
            );
            assert.strictEqual(preDoneSpans.length, 0);
            hookDone();
            const postDoneSpans = getSpans().filter(
              s =>
                !s.attributes[AttributeNames.PLUGIN_NAME] ||
                s.attributes[AttributeNames.PLUGIN_NAME] === 'fastify'
            );
            assert.strictEqual(postDoneSpans.length, 1);
          });

          it('span should end when calling reply.send from hook', async () => {
            app.addHook('onRequest', (_req, reply, _done) => {
              reply.send('request ended prematurely in hook');
            });
            app.get('/test', (_req, _reply) => {
              throw Error(
                'handler should not be executed as request is ended in onRequest hook'
              );
            });
            await startServer();
            await httpRequest.get(`http://localhost:${PORT}/test`);
            const spans = getSpans().filter(
              s =>
                !s.attributes[AttributeNames.PLUGIN_NAME] ||
                s.attributes[AttributeNames.PLUGIN_NAME] === 'fastify'
            );
            assert.strictEqual(spans.length, 1);
          });
        });
      });

      describe('application hooks', () => {
        afterEach(() => {
          const spans = getSpans();
          assert.strictEqual(spans.length, 0);
        });

        it('onRoute not instrumented', async () => {
          app.addHook('onRoute', () => {
            assertRootContextActive();
          });
          // add a route to trigger the 'onRoute' hook
          app.get('/test', (_req, reply) => {
            reply.send('OK');
          });

          await startServer();
        });

        it('onRegister is not instrumented', async () => {
          app.addHook('onRegister', () => {
            assertRootContextActive();
          });
          // register a plugin to trigger 'onRegister' hook
          app.register((fastify, options, done) => {
            done();
          });

          await startServer();
        });

        it('onReady is not instrumented', async () => {
          app.addHook('onReady', () => {
            assertRootContextActive();
          });

          await startServer();
        });

        it('onClose is not instrumented', async () => {
          app.addHook('onClose', () => {
            assertRootContextActive();
          });

          await startServer();
        });
      });

      describe('using requestHook in config', () => {
        it('calls requestHook provided function when set in config', async () => {
          const requestHook = (span, info) => {
            span.setAttribute(
              SemanticAttributes.HTTP_METHOD,
              info.request.method
            );
          };

          instrumentation.setConfig({
            ...instrumentation.getConfig(),
            requestHook,
          });

          app.get('/test', (req, res) => {
            res.send('OK');
          });

          await startServer();
          await httpRequest.get(`http://localhost:${PORT}/test`);

          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 5);
          const span = spans[2];
          assert.deepStrictEqual(span.attributes, {
            'fastify.type': 'request_handler',
            'plugin.name': 'fastify -> @fastify/express',
            [SemanticAttributes.HTTP_ROUTE]: '/test',
            [SemanticAttributes.HTTP_METHOD]: 'GET',
          });
        });

        it('does not propagate an error from a requestHook that throws exception', async () => {
          const requestHook = (span, info) => {
            span.setAttribute(
              SemanticAttributes.HTTP_METHOD,
              info.request.method
            );

            throw Error('error thrown in requestHook');
          };

          instrumentation.setConfig({
            ...instrumentation.getConfig(),
            requestHook,
          });

          app.get('/test', (req, res) => {
            res.send('OK');
          });

          await startServer();
          await httpRequest.get(`http://localhost:${PORT}/test`);

          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 5);
          const span = spans[2];
          assert.deepStrictEqual(span.attributes, {
            'fastify.type': 'request_handler',
            'plugin.name': 'fastify -> @fastify/express',
            [SemanticAttributes.HTTP_ROUTE]: '/test',
            [SemanticAttributes.HTTP_METHOD]: 'GET',
          });
        });
      });
    });
  });
});
