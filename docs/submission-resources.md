# Resources for the submission form

Project use checked against the current implementation on 2026-11-15. These
are the resources used by the implementation and the updated materials;
the original catalogue of 24 possible resources is not a list of completed integrations.

## NASA data/resources

| Link text | Full public URL | Actual use |
| --- | --- | --- |
| NASA POWER Daily API | https://power.larc.nasa.gov/docs/services/api/temporal/daily/ | Historical daily temperature, precipitation, humidity, wind and radiation for seasonal climate, FAO-56 ET₀/ETc and the index; optional wetness context. |
| NASA GIBS — MODIS Terra NDVI 8-Day | https://nasa-gibs.github.io/gibs-api-docs/ | Optional visual layer `MODIS_Terra_NDVI_8Day`; not a numerical suitability factor. |
| NASA GIBS — SMAP L4 root-zone soil moisture | https://nasa-gibs.github.io/gibs-api-docs/ | Optional visual layer `SMAP_L4_Analyzed_Root_Zone_Soil_Moisture`; not a numerical suitability factor. |

The two layer identifiers were confirmed in the public [GIBS WMTS catalogue](https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml).
NASA GIBS/ESDIS imagery is acknowledged. NASA data access does not constitute
NASA endorsement or validation of GrowWhere's scoring method.

## Space agency partner and other data/resources

| Link text | Full public URL | Actual use |
| --- | --- | --- |
| USDA NRCS Soil Data Access / SSURGO | https://sdmdataaccess.nrcs.usda.gov/ | Soil survey units and dominant-component soil properties at 0–30 cm. |
| USDA CroplandCROS / Cropland Data Layer | https://croplandcros.scinet.usda.gov/ | Land-cover checks for the selected historical year and crop-history context. |
| USDA ERS Commodity Costs and Returns | https://www.ers.usda.gov/data-products/commodity-costs-and-returns | Annual regional production costs and historical harvest prices. |
| NOAA National Weather Service API | https://www.weather.gov/documentation/services-web-api | Separate current-weather readiness check; unavailable or invalid forecasts remain explicit gaps. |
| K-State Crop Planting Temperatures | https://www.riley.k-state.edu/crops-livestock/soils-and-crops/cropplantingtemps/ | Published thresholds, distinguished from actual soil measurements or advice. |
| K-State Kansas Corn Management 2025 | https://bookstore.ksre.ksu.edu/pubs/kansas-corn-management-2025_MF3208.pdf | Partial local agronomic reference in the rules registry. |
| K-State Kansas Crop Planting Guide | https://bookstore.ksre.ksu.edu/pubs/kansas-crop-planting-guide_L818.pdf | Partial planting guidance and its regional applicability constraints. |
| FAO-56 Crop Evapotranspiration | https://www.fao.org/4/x0490e/x0490e00.htm | ET₀ method and general crop-coefficient reference; local index thresholds remain GrowWhere assumptions. |
| OpenStreetMap contributors | https://www.openstreetmap.org/copyright | Street basemap and map screenshots; displayed attribution is retained. |
| Esri World Imagery | https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer | Optional satellite basemap with provider-specific attribution; tiles are not bundled for offline redistribution. |
| Leaflet 1.9.4 | https://leafletjs.com/ | Interactive map library. Its BSD 2-Clause notice is included with the vendored files. |
| Python | https://www.python.org/ | API, source processing, numerical method and report generation. |
| SQLite / RTree | https://www.sqlite.org/rtree.html | Prepared map storage and spatial lookups. |
| Matplotlib | https://matplotlib.org/ | PDF rendering and comparison/factor charts; runtime dependencies are installed by the pinned requirement. |
| DejaVu Fonts | https://dejavu-fonts.github.io/License.html | Fonts used in the analytical PDF reports; accompanying notice is preserved. |
| Arial font family | https://learn.microsoft.com/en-us/typography/font-list/arial | System font referenced by the updated presentation; no separate font file is distributed. |
| Node.js | https://nodejs.org/ | JavaScript checks and the optional development launcher. |
| OpenAI Codex | https://openai.com/codex/ | AI assistance for implementation, documentation, testing and presentation authoring; not a source of fabricated measurements. |
| Git | https://git-scm.com/ | Version control and integration of the team repository. |
| GitHub | https://github.com/EgorStalker/GrowWhere | Public project, code and demonstration hosting. |
| GrowWhere logo — RightVersion | https://github.com/EgorStalker/GrowWhere/blob/main/apps/web/prototype/dist/assets/logo.png | Team-provided product branding. |
| GrowWhere interface screenshots | https://github.com/EgorStalker/GrowWhere/tree/main/deliverables/GrowWhere-demo/screenshots | Captures of the real English interface, including two-field comparison and PDF equations. |

Development-only PDF extraction/rendering checks also used
[pypdf](https://pypdf.readthedocs.io/),
[pypdfium2](https://pypdfium2.readthedocs.io/) and
[Pillow](https://python-pillow.org/). They are not required by the running site.

Keep dataset-specific terms and acknowledgements when obtaining or reusing
source data. This inventory does not assign a new licence to those resources.
The app exports research estimates and exposes missing data; it does not
certify agronomic or economic outcomes.
