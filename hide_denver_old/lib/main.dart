import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_map/flutter_map.dart' as fm;
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';
import 'package:turf/turf.dart' as turf;

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MissionCompanionApp());
}

class MissionCompanionApp extends StatelessWidget {
  const MissionCompanionApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Mission Area Companion',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.blueAccent),
        useMaterial3: true,
      ),
      home: const MissionMapScreen(),
    );
  }
}

class MissionMapScreen extends StatefulWidget {
  const MissionMapScreen({super.key});

  @override
  State<MissionMapScreen> createState() => _MissionMapScreenState();
}

class _MissionMapScreenState extends State<MissionMapScreen>
    with WidgetsBindingObserver, TickerProviderStateMixin {
  static const String _geoJsonAssetPath = 'assets/game_zone.geojson';
  static const double _shrinkRadiusMeters = 804.672;
  static const int _circleSegments = 144;
  static const List<LatLng> _worldRing = <LatLng>[
    LatLng(-85, -180),
    LatLng(-85, 180),
    LatLng(85, 180),
    LatLng(85, -180),
    LatLng(-85, -180),
  ];

  final fm.MapController _mapController = fm.MapController();
  final Distance _distance = const Distance();

  StreamSubscription<Position>? _positionSubscription;
  late final AnimationController _pulseController;
  late final AnimationController _warningController;

  List<LatLng> _originalZone = const <LatLng>[];
  List<LatLng> _activeZone = const <LatLng>[];
  LatLng _mapCenter = const LatLng(39.7392, -104.9903);
  LatLng? _playerPosition;
  LatLng? _droppedPin;

  bool _isLoading = true;
  bool _isMapReady = false;
  bool _isForeground = true;
  bool _isTracking = false;
  bool _isOutOfBounds = false;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    )..repeat();
    _warningController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 650),
    )..repeat(reverse: true);
    _initialize();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _stopForegroundTracking();
    _pulseController.dispose();
    _warningController.dispose();
    super.dispose();
  }

  // Foreground lifecycle state: GPS is active only while the app is resumed.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final bool nowForeground = state == AppLifecycleState.resumed;
    if (_isForeground == nowForeground) {
      return;
    }

    _isForeground = nowForeground;
    if (nowForeground) {
      _startForegroundTracking();
    } else {
      _stopForegroundTracking();
    }
  }

  Future<void> _initialize() async {
    try {
      final List<LatLng> zone = await _loadGameZoneFromAsset();
      final LatLng center = _calculateBoundsCenter(zone);

      if (!mounted) {
        return;
      }

      setState(() {
        _originalZone = zone;
        _activeZone = zone;
        _mapCenter = center;
        _isLoading = false;
      });

      await _requestLocationPermissionAndStart();
    } on FormatException catch (error) {
      _showStartupError(error.message);
    } catch (error) {
      _showStartupError('Unable to load mission data: $error');
    }
  }

  void _showStartupError(String message) {
    if (!mounted) {
      return;
    }
    setState(() {
      _errorMessage = message;
      _isLoading = false;
    });
  }

  // GeoJSON loading: reads the uMap export and extracts the largest Polygon ring.
  Future<List<LatLng>> _loadGameZoneFromAsset() async {
    final String raw = await rootBundle.loadString(_geoJsonAssetPath);
    final Object? decoded = jsonDecode(raw);
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('The game zone file is not valid GeoJSON.');
    }

    final List<LatLng>? ring = _extractPrimaryPolygonRing(decoded);
    if (ring == null || ring.length < 4) {
      throw const FormatException(
        'No usable Polygon geometry was found in assets/game_zone.geojson.',
      );
    }

    return _ensureClosedRing(ring);
  }

  List<LatLng>? _extractPrimaryPolygonRing(Map<String, dynamic> object) {
    final String? type = object['type'] as String?;

    if (type == 'FeatureCollection') {
      final Object? features = object['features'];
      if (features is! List) {
        return null;
      }

      List<LatLng>? largest;
      double largestArea = -1;
      for (final Object? feature in features) {
        if (feature is! Map<String, dynamic>) {
          continue;
        }
        final List<LatLng>? ring = _extractPrimaryPolygonRing(feature);
        if (ring == null) {
          continue;
        }
        final double area = _signedArea(ring).abs();
        if (area > largestArea) {
          largest = ring;
          largestArea = area;
        }
      }
      return largest;
    }

    if (type == 'Feature') {
      final Object? geometry = object['geometry'];
      return geometry is Map<String, dynamic>
          ? _extractPrimaryPolygonRing(geometry)
          : null;
    }

    if (type == 'Polygon') {
      final Object? coordinates = object['coordinates'];
      if (coordinates is! List || coordinates.isEmpty) {
        return null;
      }
      return _coordinatesToLatLngRing(coordinates.first);
    }

    if (type == 'MultiPolygon') {
      final Object? coordinates = object['coordinates'];
      if (coordinates is! List) {
        return null;
      }

      List<LatLng>? largest;
      double largestArea = -1;
      for (final Object? polygon in coordinates) {
        if (polygon is! List || polygon.isEmpty) {
          continue;
        }
        final List<LatLng>? ring = _coordinatesToLatLngRing(polygon.first);
        if (ring == null) {
          continue;
        }
        final double area = _signedArea(ring).abs();
        if (area > largestArea) {
          largest = ring;
          largestArea = area;
        }
      }
      return largest;
    }

    if (type == 'GeometryCollection') {
      final Object? geometries = object['geometries'];
      if (geometries is! List) {
        return null;
      }
      for (final Object? geometry in geometries) {
        if (geometry is Map<String, dynamic>) {
          final List<LatLng>? ring = _extractPrimaryPolygonRing(geometry);
          if (ring != null) {
            return ring;
          }
        }
      }
    }

    return null;
  }

  List<LatLng>? _coordinatesToLatLngRing(Object? rawRing) {
    if (rawRing is! List || rawRing.length < 4) {
      return null;
    }

    final List<LatLng> points = <LatLng>[];
    for (final Object? coordinate in rawRing) {
      if (coordinate is! List || coordinate.length < 2) {
        throw const FormatException(
          'Polygon coordinates must be [longitude, latitude] pairs.',
        );
      }
      final Object? longitude = coordinate[0];
      final Object? latitude = coordinate[1];
      if (longitude is! num || latitude is! num) {
        throw const FormatException('Polygon coordinates must be numeric.');
      }
      points.add(LatLng(latitude.toDouble(), longitude.toDouble()));
    }

    return points;
  }

  Future<void> _requestLocationPermissionAndStart() async {
    try {
      final bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) {
        _setLocationError('Location services are disabled.');
        return;
      }

      LocationPermission permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }

      if (permission == LocationPermission.denied) {
        _setLocationError('Location permission was denied.');
        return;
      }

      if (permission == LocationPermission.deniedForever) {
        _setLocationError(
          'Location permission is permanently denied. Enable it in system settings.',
        );
        return;
      }

      await _startForegroundTracking();
    } catch (error) {
      _setLocationError('Unable to start location tracking: $error');
    }
  }

  void _setLocationError(String message) {
    if (!mounted) {
      return;
    }
    setState(() => _errorMessage = message);
  }

  Future<void> _startForegroundTracking() async {
    if (!_isForeground || _isTracking || _activeZone.isEmpty) {
      return;
    }

    const LocationSettings settings = LocationSettings(
      accuracy: LocationAccuracy.high,
      distanceFilter: 5,
    );

    _positionSubscription =
        Geolocator.getPositionStream(locationSettings: settings).listen(
      _handlePositionUpdate,
      onError: (Object error) {
        _setLocationError('Location stream error: $error');
        _stopForegroundTracking();
      },
    );

    if (!mounted) {
      return;
    }
    setState(() => _isTracking = true);
  }

  void _stopForegroundTracking() {
    _positionSubscription?.cancel();
    _positionSubscription = null;
    if (mounted) {
      setState(() => _isTracking = false);
    } else {
      _isTracking = false;
    }
  }

  // Real-time geofence validation: each GPS update is checked against the active ring.
  void _handlePositionUpdate(Position position) {
    final LatLng player = LatLng(position.latitude, position.longitude);
    final bool inside = _isPointInsideActiveZone(player);

    if (!mounted) {
      return;
    }

    setState(() {
      _playerPosition = player;
      _isOutOfBounds = !inside;
      _errorMessage = null;
    });
  }

  bool _isPointInsideActiveZone(LatLng point) {
    if (_activeZone.length < 4) {
      return false;
    }

    final turf.Polygon polygon = turf.Polygon(
      coordinates: <List<turf.Position>>[_toTurfRing(_activeZone)],
    );

    return turf.booleanPointInPolygon(
      turf.Position.of(<double>[point.longitude, point.latitude]),
      polygon,
    );
  }

  // 0.5-mile shrink math: build a geodesic circle, then clip the zone by it.
  void _handleMapLongPress(fm.TapPosition tapPosition, LatLng point) {
    final List<LatLng> circle = _buildCircleRing(point);
    final List<LatLng> intersection = _clipPolygonWithConvexPolygon(
      _originalZone,
      circle,
    );

    if (intersection.length < 4) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'The 0.5-mile circle does not overlap the mission area.',
          ),
        ),
      );
      return;
    }

    setState(() {
      _droppedPin = point;
      _activeZone = intersection;
      _isOutOfBounds = _playerPosition != null &&
          !_isPointInsideRing(_playerPosition!, intersection);
    });
  }

  List<LatLng> _buildCircleRing(LatLng center) {
    final List<LatLng> points = <LatLng>[];
    for (int i = 0; i < _circleSegments; i++) {
      final double bearing = i * 360 / _circleSegments;
      points.add(_distance.offset(center, _shrinkRadiusMeters, bearing));
    }
    return _ensureClosedRing(points);
  }

  List<LatLng> _clipPolygonWithConvexPolygon(
    List<LatLng> subject,
    List<LatLng> clip,
  ) {
    List<LatLng> output = _withoutClosingPoint(subject);
    final List<LatLng> clipPoints = _withoutClosingPoint(clip);
    if (output.length < 3 || clipPoints.length < 3) {
      return const <LatLng>[];
    }

    final double clipOrientation = _signedArea(clipPoints);

    for (int i = 0; i < clipPoints.length; i++) {
      final LatLng clipStart = clipPoints[i];
      final LatLng clipEnd = clipPoints[(i + 1) % clipPoints.length];
      final List<LatLng> input = output;
      output = <LatLng>[];

      if (input.isEmpty) {
        break;
      }

      LatLng previous = input.last;
      for (final LatLng current in input) {
        final bool currentInside = _isInsideClipEdge(
          current,
          clipStart,
          clipEnd,
          clipOrientation,
        );
        final bool previousInside = _isInsideClipEdge(
          previous,
          clipStart,
          clipEnd,
          clipOrientation,
        );

        if (currentInside) {
          if (!previousInside) {
            output.add(
              _lineIntersection(previous, current, clipStart, clipEnd),
            );
          }
          output.add(current);
        } else if (previousInside) {
          output.add(_lineIntersection(previous, current, clipStart, clipEnd));
        }

        previous = current;
      }
    }

    return _ensureClosedRing(_dedupeSequentialPoints(output));
  }

  bool _isInsideClipEdge(
    LatLng point,
    LatLng edgeStart,
    LatLng edgeEnd,
    double clipOrientation,
  ) {
    final double cross = _cross(edgeStart, edgeEnd, point);
    return clipOrientation >= 0 ? cross >= -1e-12 : cross <= 1e-12;
  }

  LatLng _lineIntersection(LatLng a, LatLng b, LatLng c, LatLng d) {
    final double x1 = a.longitude;
    final double y1 = a.latitude;
    final double x2 = b.longitude;
    final double y2 = b.latitude;
    final double x3 = c.longitude;
    final double y3 = c.latitude;
    final double x4 = d.longitude;
    final double y4 = d.latitude;

    final double denominator = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (denominator.abs() < 1e-15) {
      return b;
    }

    final double px =
        ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) /
            denominator;
    final double py =
        ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) /
            denominator;

    return LatLng(py, px);
  }

  void _resetMap() {
    setState(() {
      _droppedPin = null;
      _activeZone = _originalZone;
      _isOutOfBounds = _playerPosition != null &&
          !_isPointInsideRing(_playerPosition!, _originalZone);
    });
    _fitMapToZone();
  }

  bool _isPointInsideRing(LatLng point, List<LatLng> ring) {
    final turf.Polygon polygon = turf.Polygon(
      coordinates: <List<turf.Position>>[_toTurfRing(ring)],
    );
    return turf.booleanPointInPolygon(
      turf.Position.of(<double>[point.longitude, point.latitude]),
      polygon,
    );
  }

  List<turf.Position> _toTurfRing(List<LatLng> ring) {
    return _ensureClosedRing(ring)
        .map(
          (LatLng point) =>
              turf.Position.of(<double>[point.longitude, point.latitude]),
        )
        .toList(growable: false);
  }

  List<LatLng> _ensureClosedRing(List<LatLng> ring) {
    if (ring.isEmpty) {
      return const <LatLng>[];
    }
    final List<LatLng> closed = List<LatLng>.from(ring);
    if (!_samePoint(closed.first, closed.last)) {
      closed.add(closed.first);
    }
    return closed;
  }

  List<LatLng> _withoutClosingPoint(List<LatLng> ring) {
    if (ring.length > 1 && _samePoint(ring.first, ring.last)) {
      return ring.sublist(0, ring.length - 1);
    }
    return List<LatLng>.from(ring);
  }

  List<LatLng> _dedupeSequentialPoints(List<LatLng> points) {
    final List<LatLng> deduped = <LatLng>[];
    for (final LatLng point in points) {
      if (deduped.isEmpty || !_samePoint(deduped.last, point)) {
        deduped.add(point);
      }
    }
    if (deduped.length > 1 && _samePoint(deduped.first, deduped.last)) {
      deduped.removeLast();
    }
    return deduped;
  }

  bool _samePoint(LatLng a, LatLng b) {
    return (a.latitude - b.latitude).abs() < 1e-12 &&
        (a.longitude - b.longitude).abs() < 1e-12;
  }

  double _signedArea(List<LatLng> ring) {
    final List<LatLng> points = _withoutClosingPoint(ring);
    double area = 0;
    for (int i = 0; i < points.length; i++) {
      final LatLng a = points[i];
      final LatLng b = points[(i + 1) % points.length];
      area += a.longitude * b.latitude - b.longitude * a.latitude;
    }
    return area / 2;
  }

  double _cross(LatLng a, LatLng b, LatLng p) {
    return (b.longitude - a.longitude) * (p.latitude - a.latitude) -
        (b.latitude - a.latitude) * (p.longitude - a.longitude);
  }

  LatLng _calculateBoundsCenter(List<LatLng> points) {
    double minLat = double.infinity;
    double minLng = double.infinity;
    double maxLat = -double.infinity;
    double maxLng = -double.infinity;

    for (final LatLng point in points) {
      minLat = math.min(minLat, point.latitude);
      minLng = math.min(minLng, point.longitude);
      maxLat = math.max(maxLat, point.latitude);
      maxLng = math.max(maxLng, point.longitude);
    }

    return LatLng((minLat + maxLat) / 2, (minLng + maxLng) / 2);
  }

  void _fitMapToZone() {
    if (!_isMapReady || _activeZone.isEmpty) {
      return;
    }

    final fm.LatLngBounds bounds = fm.LatLngBounds.fromPoints(_activeZone);
    _mapController.fitCamera(
      fm.CameraFit.bounds(bounds: bounds, padding: const EdgeInsets.all(44)),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    if (_originalZone.isEmpty) {
      return Scaffold(
        body: _ErrorPanel(
          message: _errorMessage ?? 'Mission area data could not be loaded.',
        ),
      );
    }

    return Scaffold(
      body: Stack(
        children: <Widget>[
          _buildMap(),
          _buildTopControls(),
          if (_errorMessage != null) _buildStatusBanner(_errorMessage!),
          if (_isOutOfBounds) _buildWarningOverlay(),
        ],
      ),
    );
  }

  // Map settings and visual layers: OpenStreetMap tiles, mask, zone, pin, player marker.
  Widget _buildMap() {
    return fm.FlutterMap(
      mapController: _mapController,
      options: fm.MapOptions(
        initialCenter: _mapCenter,
        initialZoom: 15,
        minZoom: 3,
        maxZoom: 19,
        onMapReady: () {
          _isMapReady = true;
          _fitMapToZone();
        },
        onLongPress: _handleMapLongPress,
      ),
      children: <Widget>[
        fm.TileLayer(
          urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          userAgentPackageName: 'com.example.hide_denver',
        ),
        fm.PolygonLayer(
          polygons: <fm.Polygon>[
            fm.Polygon(
              points: _worldRing,
              holePointsList: <List<LatLng>>[_activeZone],
              color: Colors.black.withValues(alpha: 0.65),
              borderStrokeWidth: 0,
            ),
            fm.Polygon(
              points: _activeZone,
              color: Colors.greenAccent.withValues(alpha: 0.12),
              borderColor: Colors.greenAccent,
              borderStrokeWidth: 3,
            ),
          ],
        ),
        if (_droppedPin != null)
          fm.CircleLayer(
            circles: <fm.CircleMarker>[
              fm.CircleMarker(
                point: _droppedPin!,
                radius: _shrinkRadiusMeters,
                useRadiusInMeter: true,
                color: Colors.blueAccent.withValues(alpha: 0.08),
                borderColor: Colors.blueAccent,
                borderStrokeWidth: 2,
              ),
            ],
          ),
        fm.MarkerLayer(markers: _buildMarkers()),
      ],
    );
  }

  List<fm.Marker> _buildMarkers() {
    return <fm.Marker>[
      if (_droppedPin != null)
        fm.Marker(
          point: _droppedPin!,
          width: 48,
          height: 48,
          child: const Icon(
            Icons.location_pin,
            color: Colors.blueAccent,
            size: 44,
          ),
        ),
      if (_playerPosition != null)
        fm.Marker(
          point: _playerPosition!,
          width: 64,
          height: 64,
          child: _PulsingCrosshair(controller: _pulseController),
        ),
    ];
  }

  Widget _buildTopControls() {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Align(
          alignment: Alignment.topRight,
          child: Wrap(
            spacing: 8,
            runSpacing: 8,
            alignment: WrapAlignment.end,
            children: <Widget>[
              FilledButton.icon(
                onPressed: _fitMapToZone,
                icon: const Icon(Icons.center_focus_strong),
                label: const Text('Center'),
              ),
              FilledButton.icon(
                onPressed: _resetMap,
                icon: const Icon(Icons.restart_alt),
                label: const Text('Reset Map'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildStatusBanner(String message) {
    return SafeArea(
      child: Align(
        alignment: Alignment.bottomCenter,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Material(
            color: Colors.black.withValues(alpha: 0.82),
            borderRadius: BorderRadius.circular(8),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              child: Text(
                message,
                style: const TextStyle(color: Colors.white),
                textAlign: TextAlign.center,
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildWarningOverlay() {
    return FadeTransition(
      opacity: Tween<double>(begin: 0.82, end: 1).animate(_warningController),
      child: Container(
        color: Colors.red.shade900,
        alignment: Alignment.center,
        padding: const EdgeInsets.all(28),
        child: const Text(
          'WARNING: YOU HAVE LEFT THE MISSION AREA.\nRETURN IMMEDIATELY.',
          textAlign: TextAlign.center,
          style: TextStyle(
            color: Colors.white,
            fontSize: 30,
            fontWeight: FontWeight.w900,
            height: 1.15,
            letterSpacing: 0,
          ),
        ),
      ),
    );
  }
}

class _PulsingCrosshair extends StatelessWidget {
  const _PulsingCrosshair({required this.controller});

  final AnimationController controller;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (BuildContext context, Widget? child) {
        final double pulse = controller.value;
        return Stack(
          alignment: Alignment.center,
          children: <Widget>[
            Container(
              width: 22 + pulse * 32,
              height: 22 + pulse * 32,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: Colors.blueAccent.withValues(alpha: (1 - pulse) * 0.28),
              ),
            ),
            Container(
              width: 26,
              height: 26,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: Colors.white,
                border: Border.all(color: Colors.blueAccent, width: 3),
                boxShadow: const <BoxShadow>[
                  BoxShadow(
                    color: Colors.black38,
                    blurRadius: 7,
                    offset: Offset(0, 2),
                  ),
                ],
              ),
              child: const Icon(
                Icons.my_location,
                color: Colors.blueAccent,
                size: 16,
              ),
            ),
          ],
        );
      },
    );
  }
}

class _ErrorPanel extends StatelessWidget {
  const _ErrorPanel({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Icon(Icons.error_outline, color: Colors.red, size: 52),
              const SizedBox(height: 16),
              Text(
                message,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
