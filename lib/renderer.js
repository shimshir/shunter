
'use strict';

module.exports = function(config) {
	var dust = require('dustjs-helpers');
	var mincer = require('mincer');
	var fs = require('fs');
	var path = require('path');
	var glob = require('glob');
	var inputFilters = require('./input-filter')(config);
	var eachModule = require('each-module');

	mincer.logger.use(config.log);

	var environment = new mincer.Environment();
	var manifest = new mincer.Manifest(environment, config.path.publicResources);
	// host app can be shunter-based app or manifest, so rely on root
	var hostAppDir = config.path.root;

	var assetPath = function(name) {
		var isProduction = config.env.isProduction();
		var asset = (isProduction) ? manifest.assets[name] : environment.findAsset(name);
		if (!asset) {
			return '';
		}

		return (
			isProduction ?
			path.join(config.web.publicResources, asset) :
			path.join(config.web.resources, asset.digestPath)
		);
	};

	environment.registerHelper('asset_path', assetPath);
	var modulesPaths = config.modules.map(function(module) {
		return path.join(hostAppDir, 'node_modules', module);
	});
	// Assets must be loaded in order (e.g. styles relies on images already being available)
	var assetTypes = [config.structure.fonts, config.structure.images, config.structure.styles, config.structure.scripts];
	var themeResourcesPath = config.path.resources;
	// NB: risk of mincer clashes until stuff is moved out of proxy
	// for each asset type, add host then module. this order is important
	assetTypes.forEach(function(assetType) {
		var newPath = path.join(themeResourcesPath, assetType);
		if (fs.existsSync(newPath)) {
			environment.appendPath(newPath);
		}
		modulesPaths.reverse().forEach(function(modulePath) {
			var newPath = path.join(modulePath, 'resources', assetType);
			if (fs.existsSync(newPath)) {
				environment.appendPath(newPath);
			}
		});
	});
	// load input filters from host app and modules
	var allFilters = [config.path.shunterRoot].concat(modulesPaths, hostAppDir);
	allFilters.forEach(function(dir) {
		var inputFilterPath = path.join(dir, config.structure.filters, config.structure.filtersInput);
		eachModule(inputFilterPath, function(name, mod) {
			if (typeof mod === 'function') {
				inputFilters.add(mod);
			}
		});
	});

	// load ejs helpers from the host app and modules
	var allHelpers = [config.path.shunterRoot].concat(modulesPaths, hostAppDir);
	allHelpers.forEach(function(dir) {
		var ejsHelperPath = path.join(dir, config.structure.ejs);
		eachModule(ejsHelperPath, function(name, mod, file) {
			if (typeof mod === 'function') {
				require(file)(environment, config);
			}
		});
	});

	return {
		TEMPLATE_CACHE_KEY_PREFIX: 'root',

		dust: dust,
		environment: environment,
		manifest: manifest,
		assetPath: assetPath,

		assetServer: function() {
			return mincer.createServer(environment);
		},

		initDustExtensions: function() {
			require('./dust')(dust, this, config);
			modulesPaths.concat([config.path.shunterRoot, hostAppDir]).forEach(function(dir) {
				var moduleDustPath = path.join(dir, config.structure.dust);
				eachModule(moduleDustPath, function(name, initDustExtension) {
					initDustExtension(dust, this, config);
				});
			});
		},

		compileFile: function(fp) {
			var ext = config.structure.templateExt;
			var id;
			var compiled;
			var sandboxNS;
			var splitPath;
			var timer;

			if (path.extname(fp) === ext) {
				sandboxNS = path.relative(config.path.themes, fp);
				// Trim out the relative paths of inherited templates
				sandboxNS = sandboxNS.substring(sandboxNS.indexOf('view'));
				splitPath = sandboxNS.split(path.sep);
				if (splitPath.indexOf(config.structure.templates) > -1) {
					// remove internal structure path
					splitPath.splice(splitPath.indexOf(config.structure.templates), 1);
				}
				// reset to basename
				splitPath[splitPath.length - 1] = path.basename(fp, ext);
				splitPath.unshift(this.TEMPLATE_CACHE_KEY_PREFIX);
				// build id from path parts
				id = splitPath.join('__');

				timer = config.timer();
				try {
					compiled = dust.compile(fs.readFileSync(fp, 'utf8'), id);
					dust.loadSource(compiled);
				} catch (e) {
					config.log.error('Compilation error: ' + e.message + ' in ' + fp);
				}
				timer('Compiling ' + fp + ' as ' + id);
			}
		},

		// Just used for testing?
		compilePaths: function(paths) {
			var self = this;
			if (typeof paths === 'string') {
				paths = [].slice.call(arguments, 0);
			}
			paths.forEach(function(name) {
				// DEPRECATED: checking both themes and templates folders for the right template file
				// when updated, should just look for 'self.compileFile(name));'
				// name will need to be full path, or contain the relevant subfolders e.g. laserwolf/views/subject/foo.dust

				if (fs.existsSync(path.join(config.path.themes, name))) {
					// themes
					self.compileFile(path.join(config.path.themes, name));
				} else if (fs.existsSync(path.join(config.path.templates, name))) {
					// old shunter-proxy
					self.compileFile(path.join(config.path.templates, name));
				} else if (fs.existsSync(name)) {
					// full path
					self.compileFile(name);
				} else {
					config.log.info('Could not find template ' + name);
				}
				// end DEPRECATED
			});
		},

		compileTemplates: function(forTests) {
			var fullFiles = [];
			// Get all defined modules templates first (in order defined by the host app)
			config.modules.forEach(function(module) {
				var moduleResourcesPath = (forTests) ? forTests : path.join(hostAppDir, 'node_modules', module);
				// must use / for glob even with windows
				var templates = [moduleResourcesPath, config.structure.templates, '**', ('*' + config.structure.templateExt)].join('/');
				fullFiles = fullFiles.concat(glob.sync(templates, {}));
			});
			// Then get the app's templates
			// (must use / for glob even with windows)
			var templates = [config.path.themes, config.structure.templates, '**', ('*' + config.structure.templateExt)].join('/');
			fullFiles = fullFiles.concat(glob.sync(templates, {}));
			this.compileFileList(fullFiles);
		},

		// accepts an array of files with full paths, sends each to compile
		compileFileList: function(fileArr) {
			var self = this;
			fileArr.forEach(function(file) {
				self.compileFile(file);
			});
		},

		watchTemplates: function() {
			var watchTree;
			var watcher;
			var folders = [config.path.templates];
			var self = this;

			var compile = function(fp) {
				self.compileFile(fp);
			};

			modulesPaths.forEach(function(mp) {
				folders.push(path.join(mp, config.structure.templates));
			});
			watchTree = require('./watcher')(config.structure.templateExt).watchTree;
			watcher = watchTree(folders, config.log);
			watcher.on('fileModified', compile);
			watcher.on('fileCreated', compile);
			config.log.info('Watching ' + folders.join(', ') + ' for changes');
		},

		watchDustExtensions: function() {
			var watchTree;
			var watcher;
			var folders = [config.path.dust];
			var self = this;

			var compile = function(fp) {
				config.log.info('Loading Dust extension ' + fp);
				delete require.cache[require.resolve(fp)];
				require(fp)(dust, self, config);
			};

			modulesPaths.forEach(function(mp) {
				folders.push(path.join(mp, config.structure.dust));
			});
			watchTree = require('./watcher')('.js').watchTree;
			watcher = watchTree(folders, config.log);
			watcher.on('fileModified', compile);
			watcher.on('fileCreated', compile);
			config.log.info('Watching ' + folders.join(', ') + ' for changes');
		},

		render: function(req, res, data, callback) {
			var name = (data && data.layout && data.layout.template) ? data.layout.template : 'layout';
			this.renderPartial(name, req, res, data, callback);
		},

		renderPartial: function(partial, req, res, data, callback) {
			inputFilters.run(req, res, data, function(data) {
				var ns = (data && data.layout && data.layout.namespace) ? data.layout.namespace : null;
				var base = dust.makeBase({
					namespace: ns
				}, {
					namespace: ns
				});
				dust.render(partial, base.push(data), function(err, out) {
					callback(err, out);
				});
			});
		}
	};
};