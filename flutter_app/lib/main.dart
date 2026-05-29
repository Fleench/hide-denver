import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:geolocator/geolocator.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await _hideSystemBars();
  runApp(const HideDenverApp());
}

Future<void> _hideSystemBars() async {
  await SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
  SystemChrome.setSystemUIChangeCallback((systemOverlaysAreVisible) async {
    if (systemOverlaysAreVisible) {
      await Future<void>.delayed(const Duration(seconds: 1));
      await SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    }
  });
}

class HideDenverApp extends StatelessWidget {
  const HideDenverApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      title: 'Mission Area Companion',
      debugShowCheckedModeBanner: false,
      home: MissionWebApp(),
    );
  }
}

class MissionWebApp extends StatefulWidget {
  const MissionWebApp({super.key});

  @override
  State<MissionWebApp> createState() => _MissionWebAppState();
}

class _MissionWebAppState extends State<MissionWebApp> {
  WebViewController? _controller;
  LocalAssetServer? _server;
  String? _error;
  bool _locationAllowed = false;

  @override
  void initState() {
    super.initState();
    unawaited(_hideSystemBars());
    _bootstrap();
  }

  @override
  void dispose() {
    unawaited(_server?.close());
    super.dispose();
  }

  Future<void> _bootstrap() async {
    try {
      _locationAllowed = await _ensureLocationPermission();
      final server = LocalAssetServer();
      await server.start();

      final controller = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setBackgroundColor(const Color(0xff101418))
        ..setNavigationDelegate(
          NavigationDelegate(
            onNavigationRequest: (request) {
              final uri = Uri.parse(request.url);
              if (_isAllowedRuntimeUrl(uri, server.origin)) {
                return NavigationDecision.navigate;
              }
              return NavigationDecision.prevent;
            },
            onWebResourceError: (error) {
              debugPrint(
                'WebView resource error ${error.errorCode}: ${error.description}',
              );
            },
          ),
        );

      final platform = controller.platform;
      if (platform is AndroidWebViewController) {
        await platform.setGeolocationEnabled(true);
        await platform.setMediaPlaybackRequiresUserGesture(false);
        await platform.setGeolocationPermissionsPromptCallbacks(
          onShowPrompt: (request) async {
            _locationAllowed =
                _locationAllowed || await _ensureLocationPermission();
            return GeolocationPermissionsResponse(
              allow: _locationAllowed,
              retain: true,
            );
          },
        );
      }

      await controller.loadRequest(server.uri('/index.html'));

      if (!mounted) {
        await server.close();
        return;
      }
      setState(() {
        _server = server;
        _controller = controller;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString());
    }
  }

  Future<bool> _ensureLocationPermission() async {
    if (!await Geolocator.isLocationServiceEnabled()) return false;
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    return permission == LocationPermission.always ||
        permission == LocationPermission.whileInUse;
  }

  bool _isAllowedRuntimeUrl(Uri uri, String localOrigin) {
    if (uri.origin == localOrigin) return true;
    if (uri.scheme == 'https' && uri.host.endsWith('basemaps.cartocdn.com')) {
      return true;
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    return Scaffold(
      backgroundColor: const Color(0xff101418),
      body: SafeArea(
        top: false,
        bottom: false,
        child: _error != null
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(
                    _error!,
                    style: const TextStyle(color: Colors.white),
                    textAlign: TextAlign.center,
                  ),
                ),
              )
            : controller == null
            ? const Center(child: CircularProgressIndicator())
            : WebViewWidget(controller: controller),
      ),
    );
  }
}

class LocalAssetServer {
  static final Uri _remoteRulesUri = Uri.https('denver.flench.me', '/rules.md');
  HttpServer? _server;

  String get origin {
    final server = _server;
    if (server == null) throw StateError('Server has not started.');
    return 'http://${server.address.address}:${server.port}';
  }

  Future<void> start() async {
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server!.listen(_handleRequest);
  }

  Uri uri(String path) => Uri.parse('$origin$path');

  Future<void> close() async {
    await _server?.close(force: true);
  }

  Future<void> _handleRequest(HttpRequest request) async {
    try {
      final normalizedPath = _normalizePath(request.uri.path);
      if (normalizedPath == '/remote-rules.md') {
        await _handleRemoteRulesRequest(request);
        return;
      }
      final assetKey = 'assets/web$normalizedPath';
      final data = await rootBundle.load(assetKey);
      final bytes = data.buffer.asUint8List(
        data.offsetInBytes,
        data.lengthInBytes,
      );

      request.response
        ..statusCode = HttpStatus.ok
        ..headers.contentType = _contentType(normalizedPath)
        ..add(Uint8List.fromList(bytes));
    } catch (_) {
      request.response.statusCode = HttpStatus.notFound;
    } finally {
      await request.response.close();
    }
  }

  Future<void> _handleRemoteRulesRequest(HttpRequest request) async {
    final client = HttpClient();
    try {
      final remoteRequest = await client.getUrl(_remoteRulesUri);
      final remoteResponse = await remoteRequest.close();
      request.response
        ..statusCode = remoteResponse.statusCode
        ..headers.contentType = ContentType('text', 'markdown', charset: 'utf-8');
      await request.response.addStream(remoteResponse);
    } finally {
      client.close(force: true);
    }
  }

  String _normalizePath(String path) {
    final decoded = Uri.decodeComponent(path);
    final clean = decoded == '/' ? '/index.html' : decoded;
    if (clean.contains('..')) return '/index.html';
    return clean;
  }

  ContentType _contentType(String path) {
    if (path.endsWith('.html')) return ContentType.html;
    if (path.endsWith('.css')) {
      return ContentType('text', 'css', charset: 'utf-8');
    }
    if (path.endsWith('.js')) {
      return ContentType('application', 'javascript', charset: 'utf-8');
    }
    if (path.endsWith('.json') ||
        path.endsWith('.geojson') ||
        path.endsWith('.webmanifest')) {
      return ContentType('application', 'json', charset: 'utf-8');
    }
    if (path.endsWith('.svg')) {
      return ContentType('image', 'svg+xml', charset: 'utf-8');
    }
    if (path.endsWith('.png')) return ContentType('image', 'png');
    return ContentType.binary;
  }
}
