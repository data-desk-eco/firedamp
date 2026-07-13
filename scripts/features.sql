-- ch4id feature catalogue → web/data/features.fgb, point features only:
-- geometries collapse to the catalogue's representative lat/lon, and
-- sprawling area/line abstractions (pipelines, fields, licence areas) are
-- dropped — a point stands them nowhere sensible. a per-source `detail`
-- string is joined in from the raw ch4id source tables so the map tooltip
-- can say what each point is.
--
-- env: CH4ID (ch4id repo root), OUT (fgb path)

load spatial;

create temp macro clean(s) as nullif(nullif(nullif(trim(s), ''), 'N/A'), 'UNKNOWN');
create temp macro joined(parts) as nullif(array_to_string(list_filter(parts, x -> x is not null), ' · '), '');

create temp view details as

-- ogim: facility type, offshore flag, admin area, spud year
select 'OGIM:' || ogim_id as id, joined([
        lower(clean(fac_type)),
        if(on_offshore = 'OFFSHORE', 'offshore', null),
        lower(clean(state_prov)), lower(clean(country)),
        if(try_cast(spud_date as date) > date '1901-01-01',
           'spudded ' || year(try_cast(spud_date as date)), null)
    ]) as detail
from read_parquet(
    getenv('CH4ID') || '/data/source/ogim/*.parquet',
    union_by_name = true, filename = true
)
where filename not similar to '.*(basins|fields|license_blocks|data_catalog)\.parquet'

union all

-- osm: the informative secondary tags
select 'OSM:' || id as id, joined([
        json_extract_string(tags, '$.substance'),
        json_extract_string(tags, '$.content'),
        json_extract_string(tags, '$.product'),
        json_extract_string(tags, '$.resource'),
        json_extract_string(tags, '$.industrial'),
        json_extract_string(tags, '$.description')
    ]) as detail
from read_parquet(getenv('CH4ID') || '/data/source/osm/features.parquet')

union all

-- gem: technology, capacity, start year, country
select 'GEM:' || asset_id as id, joined([
        clean(technology),
        if(capacity is not null,
           trim(trailing '.0' from capacity::varchar) || ' ' || coalesce(capacity_unit, ''), null),
        'started ' || start_year,
        clean(country)
    ]) as detail
from read_parquet(getenv('CH4ID') || '/data/source/gem/assets.parquet')

union all

-- mapstand: well type, offshore flag, admin area
select 'MPS:' || id as id, joined([
        lower(clean(json_extract_string(properties, '$.well_type'))),
        if(json_extract_string(properties, '$.mps_est_shore_status') = 'OFFSHORE', 'offshore', null),
        clean(json_extract_string(properties, '$.admin_area_name'))
    ]) as detail
from read_parquet(
    getenv('CH4ID') || '/data/source/mapstand/*.parquet',
    union_by_name = true
);

copy (
    select
        f.id, f.dataset, f.kind, f.name, f.operator, f.status, f.fuel,
        d.detail,
        st_point(f.lon, f.lat) as geometry
    from read_parquet(getenv('CH4ID') || '/data/features.parquet') f
    left join details d using (id)
    where f.kind not in (
        'pipeline', 'field', 'oilfield', 'gas_field', 'offshore_field',
        'licence_area', 'licence_block'
    )
) to (getenv('OUT')) with (format gdal, driver 'FlatGeobuf');
