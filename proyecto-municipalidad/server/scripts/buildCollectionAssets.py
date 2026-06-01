from __future__ import annotations

import json
import math
import tempfile
import unicodedata
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from heapq import heappop, heappush
from pathlib import Path

import shapefile
from pyproj import Transformer


ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = ROOT / "server" / "data"
PUBLIC_BARRIOS_PATH = ROOT / "public" / "data" / "barrios-asu.geojson"
SOURCE_ZIP_PATH = ROOT.parent / "MAPA-EN-CAPAS.zip"
SOURCE_SHAPE_DIR = ROOT.parent / "CARTOGRAFIA BASE"
GRAPH_NAME = "CALLES_VERS_30_01_2026"
PRECISION = 6
MAX_COMPONENT_BRIDGE_METERS = 75
GLOBAL_BRIDGE_METERS = 8
MAX_BRIDGED_COMPONENT_SIZE = 250

DEPOTS = [
    {"id": "DEP-N", "label": "Base Norte", "lat": -25.2385, "lon": -57.5545},
    {"id": "DEP-C", "label": "Base Centro", "lat": -25.2872, "lon": -57.6354},
    {"id": "DEP-S", "label": "Base Sur", "lat": -25.3368, "lon": -57.6318},
]

ROUTE_COLORS = [
    "146152",
    "44803F",
    "FF5A33",
    "0B6E4F",
    "2D7F5E",
    "C65D07",
    "7F4F24",
    "005F73",
    "3A5A40",
    "8D0801",
    "386641",
    "4F772D",
    "A44A3F",
    "2A9D8F",
    "6C757D",
]

ALL_SERVICE_DAYS = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
]

SERVICE_SLOT_HOURS = list(range(22))


@dataclass
class Barrio:
    slug: str
    nombre: str
    lat: float
    lon: float
    zona: int | None


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value)
    ascii_only = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    cleaned = []
    previous_dash = False
    for char in ascii_only.lower():
        if char.isalnum():
            cleaned.append(char)
            previous_dash = False
        elif not previous_dash:
            cleaned.append("-")
            previous_dash = True
    slug = "".join(cleaned).strip("-")
    return slug or "barrio"


def haversine(lat_a: float, lon_a: float, lat_b: float, lon_b: float) -> float:
    radius = 6_371_000
    phi_a = math.radians(lat_a)
    phi_b = math.radians(lat_b)
    delta_phi = math.radians(lat_b - lat_a)
    delta_lambda = math.radians(lon_b - lon_a)
    term = (
        math.sin(delta_phi / 2) ** 2
        + math.cos(phi_a) * math.cos(phi_b) * math.sin(delta_lambda / 2) ** 2
    )
    return 2 * radius * math.atan2(math.sqrt(term), math.sqrt(1 - term))


def format_shift_time(hour: int, minute: int) -> str:
    total_minutes = (hour * 60) + minute
    normalized = total_minutes % (24 * 60)
    next_hour = normalized // 60
    next_minute = normalized % 60
    return f"{next_hour:02d}:{next_minute:02d}:00"


def rounded_key(lat: float, lon: float) -> tuple[float, float]:
    return round(lat, PRECISION), round(lon, PRECISION)


def load_barrios() -> tuple[dict, list[Barrio]]:
    with PUBLIC_BARRIOS_PATH.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)

    barrios: list[Barrio] = []
    next_features = []
    for feature in payload.get("features", []):
        props = dict(feature.get("properties", {}))
        nombre = str(props.get("nombre", "")).strip()
        if not nombre:
            continue
        slug = slugify(nombre)
        lat = float(props["centerLat"])
        lon = float(props["centerLon"])
        barrios.append(
            Barrio(
                slug=slug,
                nombre=nombre,
                lat=lat,
                lon=lon,
                zona=int(props["zona"]) if props.get("zona") is not None else None,
            )
        )
        props["slug"] = slug
        feature["properties"] = props
        next_features.append(feature)

    payload["features"] = next_features
    barrios.sort(key=lambda barrio: barrio.nombre)
    return payload, barrios


def extract_graph_shapefile(tmp_dir: Path) -> Path:
    local_shp_path = SOURCE_SHAPE_DIR / f"{GRAPH_NAME}.shp"
    if local_shp_path.exists():
      return local_shp_path

    if not SOURCE_ZIP_PATH.exists():
        raise FileNotFoundError(f"No se encontro {SOURCE_ZIP_PATH}")

    target_base = tmp_dir / GRAPH_NAME
    with zipfile.ZipFile(SOURCE_ZIP_PATH) as archive:
        for member in archive.namelist():
            if GRAPH_NAME in member and member.lower().endswith((".shp", ".shx", ".dbf", ".prj")):
                target_path = tmp_dir / Path(member).name
                target_path.write_bytes(archive.read(member))

    shp_path = target_base.with_suffix(".shp")
    if not shp_path.exists():
        raise FileNotFoundError(f"No se pudo extraer {GRAPH_NAME}.shp")
    return shp_path


def build_graph(
    shp_path: Path,
) -> tuple[list[list], dict[int, tuple[float, float]], dict[int, list[tuple[int, float]]], list[list]]:
    transformer = Transformer.from_crs("EPSG:32721", "EPSG:4326", always_xy=True)
    node_ids: dict[tuple[float, float], int] = {}
    node_coords: dict[int, tuple[float, float]] = {}
    adjacency: dict[int, list[tuple[int, float]]] = defaultdict(list)
    edge_rows: list[list] = []
    next_node_id = 0

    def ensure_node(lat: float, lon: float) -> int:
        nonlocal next_node_id
        key = rounded_key(lat, lon)
        if key not in node_ids:
            node_ids[key] = next_node_id
            node_coords[next_node_id] = key
            next_node_id += 1
        return node_ids[key]

    reader = shapefile.Reader(str(shp_path), encoding="cp1252")
    try:
        fields = [field[0] for field in reader.fields[1:]]
        name_index = fields.index("nombre")

        for shape_record in reader.iterShapeRecords():
            street_name = shape_record.record[name_index] or ""
            raw_points = shape_record.shape.points
            if len(raw_points) < 2:
                continue
            part_indexes = list(shape_record.shape.parts or [0])
            if not part_indexes or part_indexes[0] != 0:
                part_indexes.insert(0, 0)
            part_indexes.append(len(raw_points))

            for start_index, end_index in zip(part_indexes, part_indexes[1:]):
                part_points = raw_points[start_index:end_index]
                if len(part_points) < 2:
                    continue

                transformed = []
                for x, y in part_points:
                    lon, lat = transformer.transform(x, y)
                    transformed.append((lat, lon))

                for current, following in zip(transformed, transformed[1:]):
                    if rounded_key(*current) == rounded_key(*following):
                        continue
                    current_id = ensure_node(*current)
                    next_id = ensure_node(*following)
                    distance = haversine(current[0], current[1], following[0], following[1])
                    adjacency[current_id].append((next_id, distance))
                    adjacency[next_id].append((current_id, distance))
                    edge_rows.append([current_id, next_id, round(distance, 3), street_name])
    finally:
        reader.close()

    nodes = [[node_id, lat, lon] for node_id, (lat, lon) in sorted(node_coords.items())]
    return nodes, node_coords, adjacency, edge_rows


def build_connected_components(
    node_coords: dict[int, tuple[float, float]],
    adjacency: dict[int, list[tuple[int, float]]],
) -> tuple[dict[int, int], dict[int, list[int]]]:
    component_by_node: dict[int, int] = {}
    nodes_by_component: dict[int, list[int]] = {}
    component_id = 0

    for node_id in node_coords:
        if node_id in component_by_node:
            continue

        stack = [node_id]
        component_nodes: list[int] = []
        component_by_node[node_id] = component_id

        while stack:
            current = stack.pop()
            component_nodes.append(current)
            for neighbor, _distance in adjacency.get(current, []):
                if neighbor in component_by_node:
                    continue
                component_by_node[neighbor] = component_id
                stack.append(neighbor)

        nodes_by_component[component_id] = component_nodes
        component_id += 1

    return component_by_node, nodes_by_component


def bridge_disconnected_components(
    node_coords: dict[int, tuple[float, float]],
    adjacency: dict[int, list[tuple[int, float]]],
    edge_rows: list[list],
) -> int:
    component_by_node, nodes_by_component = build_connected_components(node_coords, adjacency)
    if len(nodes_by_component) <= 1:
        return 0

    component_sizes = {
        component_id: len(component_nodes)
        for component_id, component_nodes in nodes_by_component.items()
    }
    main_component_id = max(component_sizes, key=component_sizes.get)

    node_degree = {
        node_id: len(adjacency.get(node_id, []))
        for node_id in node_coords
    }

    meters_per_degree_lat = 111_320
    approx_center_lat = (
        sum(lat for lat, _lon in node_coords.values()) / len(node_coords)
        if node_coords
        else -25.28
    )
    meters_per_degree_lon = meters_per_degree_lat * math.cos(math.radians(approx_center_lat))

    lat_step = MAX_COMPONENT_BRIDGE_METERS / meters_per_degree_lat
    lon_step = MAX_COMPONENT_BRIDGE_METERS / max(meters_per_degree_lon, 1.0)

    def bucket_key(lat: float, lon: float) -> tuple[int, int]:
        return int(lat / lat_step), int(lon / lon_step)

    buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
    for node_id, (lat, lon) in node_coords.items():
        buckets[bucket_key(lat, lon)].append(node_id)

    best_bridge_by_component: dict[int, tuple[float, int, int]] = {}
    near_duplicate_pairs: dict[tuple[int, int], tuple[float, int, int]] = {}

    for node_id, (lat, lon) in node_coords.items():
        own_component = component_by_node[node_id]
        own_bucket_lat, own_bucket_lon = bucket_key(lat, lon)

        for delta_lat in (-1, 0, 1):
            for delta_lon in (-1, 0, 1):
                candidate_ids = buckets.get((own_bucket_lat + delta_lat, own_bucket_lon + delta_lon), [])
                for candidate_id in candidate_ids:
                    if candidate_id <= node_id:
                        continue

                    candidate_component = component_by_node[candidate_id]
                    if candidate_component == own_component:
                        continue

                    candidate_lat, candidate_lon = node_coords[candidate_id]
                    gap_distance = haversine(lat, lon, candidate_lat, candidate_lon)
                    if gap_distance > MAX_COMPONENT_BRIDGE_METERS:
                        continue

                    component_pair = tuple(sorted((own_component, candidate_component)))
                    current_pair = near_duplicate_pairs.get(component_pair)
                    if gap_distance <= GLOBAL_BRIDGE_METERS and (
                        current_pair is None or gap_distance < current_pair[0]
                    ):
                        near_duplicate_pairs[component_pair] = (gap_distance, node_id, candidate_id)

                    if own_component == main_component_id:
                        minor_component = candidate_component
                    elif candidate_component == main_component_id:
                        minor_component = own_component
                    else:
                        continue

                    if component_sizes[minor_component] > MAX_BRIDGED_COMPONENT_SIZE:
                        continue

                    current_best = best_bridge_by_component.get(minor_component)
                    score = (
                        gap_distance,
                        max(node_degree.get(node_id, 0), node_degree.get(candidate_id, 0)),
                    )
                    current_score = (
                        current_best[0],
                        max(
                            node_degree.get(current_best[1], 0),
                            node_degree.get(current_best[2], 0),
                        ),
                    ) if current_best else None
                    if current_best is None or score < current_score:
                        best_bridge_by_component[minor_component] = (gap_distance, node_id, candidate_id)

    bridge_candidates = list(near_duplicate_pairs.values()) + list(best_bridge_by_component.values())
    bridge_candidates.sort(key=lambda item: item[0])

    existing_pairs = {
        tuple(sorted((start_id, end_id)))
        for start_id, neighbors in adjacency.items()
        for end_id, _distance in neighbors
        if start_id < end_id
    }

    bridges_added = 0
    for gap_distance, start_id, end_id in bridge_candidates:
        edge_key = tuple(sorted((start_id, end_id)))
        if edge_key in existing_pairs:
            continue
        adjacency[start_id].append((end_id, gap_distance))
        adjacency[end_id].append((start_id, gap_distance))
        edge_rows.append([start_id, end_id, round(gap_distance, 3), "__bridge__"])
        existing_pairs.add(edge_key)
        bridges_added += 1

    return bridges_added


def nearest_node(lat: float, lon: float, node_coords: dict[int, tuple[float, float]]) -> int:
    best_id = -1
    best_distance = float("inf")
    for node_id, (node_lat, node_lon) in node_coords.items():
        distance = haversine(lat, lon, node_lat, node_lon)
        if distance < best_distance:
            best_distance = distance
            best_id = node_id
    if best_id < 0:
        raise RuntimeError("No se encontro un nodo cercano en la red vial")
    return best_id


def nearest_barrios_order(barrios: list[Barrio], depot: dict) -> list[Barrio]:
    if not barrios:
        return []

    remaining = barrios[:]
    current = min(remaining, key=lambda barrio: haversine(depot["lat"], depot["lon"], barrio.lat, barrio.lon))
    ordered = [current]
    remaining.remove(current)

    while remaining:
        current = min(
            remaining,
            key=lambda barrio: haversine(ordered[-1].lat, ordered[-1].lon, barrio.lat, barrio.lon),
        )
        ordered.append(current)
        remaining.remove(current)

    return ordered


def assign_depots(barrios: list[Barrio]) -> dict[str, list[Barrio]]:
    groups: dict[str, list[Barrio]] = {depot["id"]: [] for depot in DEPOTS}
    for barrio in barrios:
        depot = min(
            DEPOTS,
            key=lambda candidate: haversine(barrio.lat, barrio.lon, candidate["lat"], candidate["lon"]),
        )
        groups[depot["id"]].append(barrio)
    return groups


def initialize_centers(points: list[tuple[float, float]], k: int) -> list[tuple[float, float]]:
    centers = [points[0]]
    while len(centers) < k:
        farthest = max(
            points,
            key=lambda point: min(haversine(point[0], point[1], center[0], center[1]) for center in centers),
        )
        centers.append(farthest)
    return centers


def kmeans_cluster(barrios: list[Barrio], k: int) -> list[list[Barrio]]:
    points = [(barrio.lat, barrio.lon) for barrio in barrios]
    centers = initialize_centers(points, k)

    for _ in range(20):
        clusters: list[list[Barrio]] = [[] for _ in range(k)]
        for barrio in barrios:
            distances = [
                haversine(barrio.lat, barrio.lon, center_lat, center_lon)
                for center_lat, center_lon in centers
            ]
            cluster_index = distances.index(min(distances))
            clusters[cluster_index].append(barrio)

        next_centers = []
        for index, cluster in enumerate(clusters):
            if not cluster:
                next_centers.append(centers[index])
                continue
            next_centers.append(
                (
                    sum(item.lat for item in cluster) / len(cluster),
                    sum(item.lon for item in cluster) / len(cluster),
                )
            )

        if all(
            haversine(a[0], a[1], b[0], b[1]) < 1.0
            for a, b in zip(centers, next_centers)
        ):
            centers = next_centers
            break

        centers = next_centers

    non_empty = [cluster for cluster in clusters if cluster]
    non_empty.sort(
        key=lambda cluster: (
            -sum(item.lat for item in cluster) / len(cluster),
            sum(item.lon for item in cluster) / len(cluster),
        )
    )
    return non_empty


def a_star_path(
    start_id: int,
    goal_id: int,
    node_coords: dict[int, tuple[float, float]],
    adjacency: dict[int, list[tuple[int, float]]],
) -> list[int]:
    open_heap = [(0.0, start_id)]
    came_from: dict[int, int] = {}
    g_score = {start_id: 0.0}

    goal_lat, goal_lon = node_coords[goal_id]

    while open_heap:
        _, current = heappop(open_heap)
        if current == goal_id:
            path = [current]
            while current in came_from:
                current = came_from[current]
                path.append(current)
            return list(reversed(path))

        current_score = g_score[current]
        for neighbor, distance in adjacency[current]:
            tentative = current_score + distance
            if tentative >= g_score.get(neighbor, float("inf")):
                continue
            came_from[neighbor] = current
            g_score[neighbor] = tentative
            neighbor_lat, neighbor_lon = node_coords[neighbor]
            heuristic = haversine(neighbor_lat, neighbor_lon, goal_lat, goal_lon)
            heappush(open_heap, (tentative + heuristic, neighbor))

    return [start_id, goal_id]


def build_route_shape(
    depot: dict,
    ordered_barrios: list[Barrio],
    node_coords: dict[int, tuple[float, float]],
    adjacency: dict[int, list[tuple[int, float]]],
) -> tuple[list[list[float]], list[int], float]:
    anchor_points = [(depot["lat"], depot["lon"])] + [
        (barrio.lat, barrio.lon) for barrio in ordered_barrios
    ] + [(depot["lat"], depot["lon"])]
    anchor_node_ids = [nearest_node(lat, lon, node_coords) for lat, lon in anchor_points]

    shape: list[list[float]] = []
    barrio_anchor_indexes: list[int] = []
    total_distance = 0.0

    for index, (start_id, goal_id) in enumerate(zip(anchor_node_ids, anchor_node_ids[1:])):
        path_node_ids = a_star_path(start_id, goal_id, node_coords, adjacency)
        path_coords = [[node_coords[node_id][0], node_coords[node_id][1]] for node_id in path_node_ids]
        if not shape:
            shape.extend(path_coords)
        else:
            shape.extend(path_coords[1:])

        segment_distance = 0.0
        for current, following in zip(path_coords, path_coords[1:]):
            segment_distance += haversine(current[0], current[1], following[0], following[1])
        total_distance += segment_distance

        if 0 < index + 1 <= len(ordered_barrios):
            barrio_anchor_indexes.append(len(shape) - 1)

    return shape, barrio_anchor_indexes, total_distance


def build_service_plan(barrios: list[Barrio], node_coords, adjacency) -> dict:
    depot_groups = assign_depots(barrios)
    trucks = []
    for depot_index, depot in enumerate(DEPOTS):
        for local_index in range(12):
            truck_number = depot_index * 12 + local_index + 1
            trucks.append(
                {
                    "id": f"TRK{truck_number:02d}",
                    "label": f"Camion {truck_number:02d}",
                    "depotId": depot["id"],
                    "active": True,
                }
            )

    routes = []
    route_counter = 1

    for depot_index, depot in enumerate(DEPOTS):
        depot_barrios = depot_groups[depot["id"]]
        clusters = kmeans_cluster(depot_barrios, 5)
        depot_trucks = [truck["id"] for truck in trucks if truck["depotId"] == depot["id"]]

        for cluster_index, cluster in enumerate(clusters):
            route_id = f"R{route_counter:02d}"
            ordered_barrios = nearest_barrios_order(cluster, depot)
            shape, anchor_indexes, total_distance = build_route_shape(depot, ordered_barrios, node_coords, adjacency)

            first_name = ordered_barrios[0].nombre
            last_name = ordered_barrios[-1].nombre
            region_label = depot["label"].replace("Base ", "")

            service_patterns = []
            for slot_index, slot_hour in enumerate(SERVICE_SLOT_HOURS):
                service_patterns.append(
                    {
                        "id": f"{route_id}-S{slot_index + 1:02d}",
                        "label": f"Turno {slot_index + 1}",
                        "days": ALL_SERVICE_DAYS,
                        "startTime": format_shift_time(slot_hour, 10 + (cluster_index * 10)),
                        "truckId": depot_trucks[(cluster_index + slot_index) % len(depot_trucks)],
                    }
                )

            routes.append(
                {
                    "id": route_id,
                    "shortName": route_id,
                    "longName": f"Corredor {region_label} {cluster_index + 1} - {first_name} / {last_name}",
                    "color": ROUTE_COLORS[route_counter - 1],
                    "depotId": depot["id"],
                    "totalDistanceMeters": round(total_distance, 3),
                    "shape": shape,
                    "anchorIndexes": anchor_indexes,
                    "barrios": [
                        {
                            "id": barrio.slug,
                            "label": barrio.nombre,
                            "lat": barrio.lat,
                            "lon": barrio.lon,
                            "sequence": index + 1,
                            "isPrimary": True,
                        }
                        for index, barrio in enumerate(ordered_barrios)
                    ],
                    "servicePatterns": service_patterns,
                }
            )
            route_counter += 1

    return {
        "generatedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "depots": DEPOTS,
        "trucks": trucks,
        "routes": routes,
    }


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    barrios_geojson, barrios = load_barrios()
    write_json(OUTPUT_DIR / "barrios-asu.geojson", barrios_geojson)

    local_shp_path = SOURCE_SHAPE_DIR / f"{GRAPH_NAME}.shp"
    if local_shp_path.exists():
        nodes, node_coords, adjacency, edges = build_graph(local_shp_path)
    else:
        with tempfile.TemporaryDirectory() as tmp_name:
            tmp_dir = Path(tmp_name)
            shp_path = extract_graph_shapefile(tmp_dir)
            nodes, node_coords, adjacency, edges = build_graph(shp_path)

    bridges_added = bridge_disconnected_components(node_coords, adjacency, edges)

    graph_payload = {
        "generatedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "nodePrecision": PRECISION,
        "nodes": nodes,
        "edges": edges,
    }
    write_json(OUTPUT_DIR / "calles-asu.graph.json", graph_payload)

    service_plan = build_service_plan(barrios, node_coords, adjacency)
    write_json(OUTPUT_DIR / "collection-service-plan.json", service_plan)

    print(f"barrios: {len(barrios)}")
    print(f"graph nodes: {len(nodes)}")
    print(f"graph edges: {len(edges)}")
    print(f"graph bridges: {bridges_added}")
    print(f"routes: {len(service_plan['routes'])}")


if __name__ == "__main__":
    main()
