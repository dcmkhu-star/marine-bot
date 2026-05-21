const https = require('https');

const STATION = { station: 'NYH1927', bin: '13', units: 'english' };
const WEATHER_COORDS = { lat: '40.7198', lon: '-73.993' };

function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/geo+json', ...headers } }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Invalid JSON response from ${url}: ${error.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function pad(value) {
  return value.toString().padStart(2, '0');
}

function parseInputDateTime(input) {
  const parts = input.trim().split(/\s+/);
  if (parts.length < 4) {
    throw new Error('Input must be: MM DD YYYY h:mm AM/PM');
  }

  const [month, day, year, ...timeParts] = parts;
  const time = timeParts.join(' ');
  const date = new Date(`${year}-${pad(month)}-${pad(day)} ${time}`);

  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid date/time format. Use MM DD YYYY h:mm AM/PM.');
  }

  return date;
}

function formatApiDate(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function formatDateTimeForComparison(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatEventTime(dateTimeString) {
  const date = new Date(dateTimeString.replace(' ', 'T'));
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatNumber(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }
  const num = Number(value);
  if (Number.isNaN(num)) return null;
  return Number(num.toFixed(decimals)).toString();
}

function toFahrenheit(temp, unitCode) {
  if (temp === null) return null;
  if (unitCode && unitCode.toLowerCase().includes('degf')) {
    return temp;
  }
  if (unitCode && unitCode.toLowerCase().includes('degc')) {
    return temp * 9 / 5 + 32;
  }
  // Assume Celsius if unknown
  return temp * 9 / 5 + 32;
}

function toMph(speed, unitCode) {
  if (speed === null) return null;
  const value = Number(speed);
  if (Number.isNaN(value)) return null;
  if (unitCode) {
    const code = unitCode.toLowerCase();
    if (code.includes('km_h')) return value * 0.621371;
    if (code.includes('m_s')) return value * 2.23693629;
    if (code.includes('knot') || code.includes('kt')) return value * 1.15077945;
    if (code.includes('mi_h')) return value;
  }
  // Default assume km/h
  return value * 0.621371;
}

async function getWindAndTemperature() {
  const pointUrl = `https://api.weather.gov/points/${WEATHER_COORDS.lat},${WEATHER_COORDS.lon}`;
  const pointData = await httpGetJson(pointUrl);
  const stationsUrl = pointData.properties?.observationStations;
  if (!stationsUrl) {
    return { temperature: 'N/A', wind: 'N/A' };
  }

  const stationsData = await httpGetJson(stationsUrl);
  const stationId = stationsData.features?.[0]?.properties?.stationIdentifier;
  if (!stationId) {
    return { temperature: 'N/A', wind: 'N/A' };
  }

  const obsUrl = `https://api.weather.gov/stations/${stationId}/observations/latest`;
  const obsData = await httpGetJson(obsUrl);
  const tempObj = obsData.properties?.temperature;
  const windObj = obsData.properties?.windSpeed;

  const tempF = toFahrenheit(tempObj?.value, tempObj?.unitCode);
  const windMph = toMph(windObj?.value, windObj?.unitCode);

  const temperature = tempF !== null ? `${Math.round(tempF)}°F` : 'N/A';
  const wind = windMph !== null ? `${Math.round(windMph)} mph` : 'N/A';

  return { temperature, wind };
}

async function getCurrents(beginDate) {
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents_predictions&format=json&station=${STATION.station}&bin=${STATION.bin}&units=${STATION.units}&begin_date=${beginDate}&range=48&date_timeUnits=24hr&interval=MAX_SLACK&time_zone=lst`;
  const data = await httpGetJson(url);
  return data.current_predictions?.cp || [];
}

async function getMarineData(input) {
  const startDate = parseInputDateTime(input);
  const endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000);
  const beginDate = formatApiDate(startDate);
  const startKey = formatDateTimeForComparison(startDate);
  const endKey = formatDateTimeForComparison(endDate);

  const [weather, currents] = await Promise.all([
    getWindAndTemperature(),
    getCurrents(beginDate),
  ]);

  const events = currents.filter((item) => {
    const timeKey = item.Time;
    return timeKey >= startKey && timeKey <= endKey;
  }).map(item => ({
    type: item.Type?.toLowerCase() || 'current',
    speed: formatNumber(item.Velocity_Major, 2),
    time: item.Time,
  }));

  let output = `Wind: ${weather.wind}\n`;
  output += `Temperature: ${weather.temperature}\n`;
  output += `Current:\n`;

  if (events.length === 0) {
    output += 'No current events found in the requested 2-hour window.\n';
  } else {
    events.forEach((event, index) => {
      const timeText = formatEventTime(event.time);
      const eventLabel = event.type === 'slack'
        ? 'slack'
        : `${event.type} ${event.speed ? `${event.speed} knots` : ''}`.trim();
      output += `${index + 1}. ${eventLabel} (${timeText})\n`;
    });
  }

  return output;
}

if (require.main === module) {
  const rawArgs = process.argv.slice(2);
  const input = rawArgs.length > 0 ? rawArgs.join(' ') : '04 12 2026 5:14 AM';
  getMarineData(input)
    .then(console.log)
    .catch((error) => {
      console.error('Error:', error.message);
      process.exitCode = 1;
    });
}

module.exports = { getMarineData };