import isURL from 'jgb-shared/lib/utils/isUrl'
import urlJoin from 'jgb-shared/lib/utils/urlJoin'
import matchesPattern from './matchesPattern'

const types = require('babel-types');
const template = require('babel-template');
const traverse = require('babel-traverse').default;
const nodeBuiltins = require('node-libs-browser');

const requireTemplate = template('require("_bundle_loader")');
const argTemplate = template('require.resolve(MODULE)');
const serviceWorkerPattern = ['navigator', 'serviceWorker', 'register'];

export default {
  ImportDeclaration(node, asset) {
    asset.isES6Module = true;
    addDependency(asset, node.source);
  },

  ExportNamedDeclaration(node, asset) {
    asset.isES6Module = true;
    if (node.source) {
      addDependency(asset, node.source);
    }
  },

  ExportAllDeclaration(node, asset) {
    asset.isES6Module = true;
    addDependency(asset, node.source);
  },

  ExportDefaultDeclaration(node, asset) {
    asset.isES6Module = true;
  },

  CallExpression(node, asset, ancestors) {
    let {callee, arguments: args} = node;

    let isRequire = types.isIdentifier(callee) &&
      callee.name === 'require' &&
      args.length === 1 &&
      types.isStringLiteral(args[0]) &&
      !hasBinding(ancestors, 'require') &&
      !isInFalsyBranch(ancestors);

    if (isRequire) {
      let optional = ancestors.some(a => types.isTryStatement(a)) || undefined;
      addDependency(asset, args[0], {
        optional
      });
      return;
    }

    let isDynamicImport = callee.type === 'Import' &&
    args.length === 1 &&
    types.isStringLiteral(args[0]);

    if (isDynamicImport) {
      asset.addDependency('_bundle_loader');
      addDependency(asset, args[0], {
        dynamic: true
      });

      node.callee = requireTemplate().expression;
      node.arguments[0] = argTemplate({
        MODULE: args[0]
      }).expression;
      return;
    }

    const isRegisterServiceWorker = types.isStringLiteral(args[0]) &&
    matchesPattern(callee, serviceWorkerPattern);

    if (isRegisterServiceWorker) {
      // Treat service workers as an entry point so filenames remain consistent across builds.
      // https://developers.google.com/web/fundamentals/primers/service-workers/lifecycle#avoid_changing_the_url_of_your_service_worker_script
      addURLDependency(asset, args[0], {
        entry: true,
        isolated: true
      });
      return;
    }
  },

  NewExpression(node, asset) {
    const {callee, arguments: args} = node;

    const isWebWorker = callee.type === 'Identifier' &&
    callee.name === 'Worker' &&
    args.length === 1 &&
    types.isStringLiteral(args[0]);

    if (isWebWorker) {
      addURLDependency(asset, args[0], {
        isolated: true
      });
      return;
    }
  }
};

function hasBinding(node, name) {
  if (Array.isArray(node)) {
    return node.some(ancestor => hasBinding(ancestor, name));
  } else if (
    types.isProgram(node) ||
    types.isBlockStatement(node) ||
    types.isBlock(node)
  ) {
    return node.body.some(statement => hasBinding(statement, name));
  } else if (
    types.isFunctionDeclaration(node) ||
    types.isFunctionExpression(node) ||
    types.isArrowFunctionExpression(node)
  ) {
    return (
      (node.id !== null && node.id.name === name) ||
      node.params.some(
        param => types.isIdentifier(param) && param.name === name
      )
    );
  } else if (types.isVariableDeclaration(node)) {
    return node.declarations.some(declaration => declaration.id.name === name);
  }

  return false;
}

function isInFalsyBranch(ancestors) {
  // Check if any ancestors are if statements
  return ancestors.some((node, index) => {
    if (types.isIfStatement(node)) {
      let res = evaluateExpression(node.test);
      if (res && res.confident) {
        // If the test is truthy, exclude the dep if it is in the alternate branch.
        // If the test if falsy, exclude the dep if it is in the consequent branch.
        let child = ancestors[index + 1];
        return res.value ? child === node.alternate : child === node.consequent;
      }
    }
  });
}

function evaluateExpression(node) {
  // Wrap the node in a standalone program so we can traverse it
  node = types.file(types.program([types.expressionStatement(node)]));

  // Find the first expression and evaluate it.
  let res = null;
  traverse(node, {
    Expression(path) {
      res = path.evaluate();
      path.stop();
    }
  });

  return res;
}

function addDependency(asset, node, opts = {}) {
  // Don't bundle node builtins
  if (asset.options.target === 'node' && node.value in nodeBuiltins) {
    return;
  }

  opts.loc = node.loc && node.loc.start;
  opts.node = node;
  // todo: if node.value is in node_modules
  // try replace value to npm/
  asset.addDependency(node.value, opts);
  asset.isAstDirty = true;
}

async function addURLDependency(asset, node, opts = {}) {
  opts.loc = node.loc && node.loc.start;

  let assetPath = asset.addURLDependency(node.value, opts);
  if (!isURL(assetPath)) {
    assetPath = urlJoin(asset.options.publicURL, assetPath);
  }
  node.value = assetPath;
  asset.isAstDirty = true;
}