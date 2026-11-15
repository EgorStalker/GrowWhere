# GrowWhere — submission text

## Project name

GrowWhere

## Short summary

GrowWhere is a map-based prototype that helps farmers explore what to grow and compare where to grow it using NASA weather data and USDA soil and cropland information. Users draw a field or search an area, choose one of seven crops, and set an irrigation scenario. The map displays historical suitability and explicit No data zones, alongside annual cost and harvest-price context. Users can compare two fields and download a PDF containing the calculation formulas, available inputs, source versions, and limitations. Prepared map products make exploration responsive without recalculating every map movement. The current scored pilot covers Kansas; the interface supports North American navigation. GrowWhere makes agricultural data easier to examine while clearly distinguishing research screening from validated planting or irrigation advice.

## Public project link

https://github.com/EgorStalker/GrowWhere

## Public demonstration link

https://github.com/EgorStalker/GrowWhere/blob/main/deliverables/GrowWhere-demo/GrowWhere-demo.pdf

Publication status: the demonstration is being prepared; the URL above is the
intended destination and is not ready for submission yet. The final
demonstration will contain 7 slides, including the title and introduction.
The longer analytical report produced by the app is a separate document and is
not the demonstration file for this field.

## Project details

### What we developed

GrowWhere is a map-based prototype for exploring crop suitability and comparing
agricultural scenarios. A user either draws a field boundary or starts a search
for suitable areas, selects a crop, and describes the intended growing scale
and irrigation conditions. The result stays connected to the selected place:
colored zones, an explanation of the limiting factors, historical economic
context, and explicit missing-data states.

Seven crop profiles are available: spring wheat, soybeans, corn, sorghum,
spring barley, oats and cotton. The current interface is English and uses
large controls, a five-step flow, keyboard support and a larger-text toggle.
It is designed to be approachable for farmers with limited experience using
digital analysis tools.

### How the analysis works

NASA POWER daily weather inputs support the temperature assessment and FAO-56
Penman–Monteith reference evapotranspiration calculation. Crop coefficients
convert daily ET₀ into seasonal crop water demand. Soil pH, water capacity,
drainage, slope and texture come from USDA SSURGO. USDA Cropland Data Layer
information checks whether the sampled land cover can enter the assessment.
The transparent index combines seven normalized factors using explicit weights
and a critical-limitation rule. Its weights and thresholds are research
assumptions that still require local calibration.

Map scores are calculated ahead of time and stored as immutable, versioned
products in SQLite with spatial indexes. The browser requests the prepared
geometry and values for its current scenario. Joining adjacent zones of the
same class removes internal visual seams without filling data gaps or changing
the analytical values. Increasing the display scale does not create additional
source precision.

Users can save one field, inspect another, and compare their recorded scores,
seven factors and seasonal water balance side by side. Comparisons identify
different crops, years, reference dates or irrigation scenarios; incomplete
results receive no overall preference. PDF export preserves the chosen
scenario, source versions and available values, and includes a complete
equation appendix. It distinguishes point calculations, five-point overview
averages and field aggregation, instead of treating those operations as
interchangeable.

### Why it matters

Soil, weather and water information is often difficult to interpret together.
GrowWhere aims to reduce that effort by making the location, assumptions and
trade-offs visible in one workflow. Farmers can explore the effects of crop
choice and additional-water scenarios and take an understandable report into
a discussion with a local agronomist. Real-world effects on yields or costs
require field trials; they have not been established by this prototype.

### Tools and resources

The application uses HTML, CSS and JavaScript with Leaflet 1.9.4, a Python HTTP
API, SQLite/RTree storage and Matplotlib for PDF reports. NASA GIBS provides
optional MODIS Terra NDVI and SMAP root-zone moisture visualizations, separate
from the index. USDA ERS supplies annual regional cost and harvest-price
context. NOAA NWS and selected K-State publications support a separate
planning-readiness check. Development and documentation were assisted by
OpenAI Codex, with automated and browser checks of the implementation.

### Current scope and next steps

The current prepared numerical pilot is Kansas, using the 2025 historical
season and explicit water scenarios. The interface permits North American
navigation, while unprepared territories or scenarios show No data. The method
has not undergone field calibration. Coarse climate data, sampled land cover
and approximate area weights limit the interpretation of individual fields.
Daily intermediate values are not all retained in the prepared products, so
reports show equations without fabricating missing numerical substitutions.

Verified sowing dates, recommended irrigation volumes and current market demand
remain unavailable. Future work includes compatible continental soil coverage,
finer prepared products, a background refresh scheduler, local soil measurements
and field validation. These are development plans, not claims of current coverage.

## NASA data and other resources

Use the copy-ready names and full URLs in [submission-resources.md](submission-resources.md)
or [the CSV inventory](submission-resources.csv).
