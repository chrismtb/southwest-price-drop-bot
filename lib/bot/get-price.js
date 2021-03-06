const cheerio = require('cheerio');
const dateFormat = require('dateformat');
const puppeteer = require('puppeteer');
const { ALERT_TYPES, MAX_PAGES } = require('../constants.js');

async function getPriceForFlight ({ from, to, date, number, alertType }, browser, lock) {
  const flights = (await getFlights({
    from,
    to,
    departDate: date,
    browser,
    lock
  })).outbound;

  let options;
  if (alertType === ALERT_TYPES.SINGLE) {
    options = flights.filter(f => f.number === number);
  } else if (alertType === ALERT_TYPES.DAY) {
    options = flights;
  } else if (alertType === ALERT_TYPES.RANGE) {
    return;
  }
  const prices = options.map(f => f.price);
  console.log('Min price: ' + Math.min(...prices));
  return Math.min(...prices);
}

async function getFlights ({ from, to, departDate, returnDate, browser, lock }) {
  const twoWay = Boolean(departDate && returnDate);
  const fares = { outbound: [] };

  if (twoWay) fares.return = [];

  let html = '';
  let closeBrowserOnExit = false;
  if (browser === undefined) {
    browser = await puppeteer.launch({args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']});
    closeBrowserOnExit = true;
  }

  try {
    if (lock) {
      console.debug('lock has available permits: ' + lock.getPermits());
      await lock.wait();
      console.debug('Entered lock, available permits: ' + lock.getPermits());
      html = await getPage(from, to, departDate, returnDate, browser);
      await lock.signal();
      console.debug('Exited lock, available permits: ' + lock.getPermits());
    } else {
      html = await getPage(from, to, departDate, returnDate, browser);
    }
  } catch (e) {
    console.error(e);
    if (lock) {
      const numPermits = lock.getPermits();
      if (numPermits !== MAX_PAGES) { await lock.signal(); }
    }
  }

  if (closeBrowserOnExit) { await browser.close(); }

  const $ = cheerio.load(html);

  const departingFlights = $(`#air-booking-product-0 > div > ul > li.air-booking-select-detail`);
  if (departingFlights.length) {
    departingFlights.toArray().forEach(e => parseTrip(e, fares.outbound));
  } else {
    console.error('No flights found!');
  }

  if (twoWay) {
    const returningFlights = $(`#air-booking-product-1 > div > ul > li.air-booking-select-detail`);
    if (returningFlights.length) {
      returningFlights.toArray().forEach(e => parseTrip(e, fares.return));
    }
  }

  return fares;

  function parseTrip (e, dest, international = false) {
    console.log('------------------ New trip price ---------------');

    const flights = $(e).find('.select-detail--flight-numbers').find('.actionable--text')
      .text()
      .substr(2)      // remove "# "
      .split(' / ')
      .join(',');
    console.log('flights: ', flights);

    const durationAndStops = $(e).find('.flight-stops--duration')
      .text();
    const duration = $(e).find('.flight-stops--duration-time').text();
    const stops_ = durationAndStops
      .split(duration)[1]   // split on the duration -> eg 'Duration8h 5m1stop' -> ['Duration', '1 stop']
      .split(' ');          // '1 stop' -> ['1', 'stop']

    const stops = stops_[0] === '' ? 0 : parseInt(stops_[0], 10);
    console.log('stops: ', stops);

    const priceStrDict = {};
    const classes = ['Business Select', 'Anytime', 'Wanna Get Away'];
    $(e).find('.fare-button--text').each(function (i, elem) {
      if ($(this).text() === 'Sold out') { priceStrDict[classes[i]] = 'Infinity'; } else { priceStrDict[classes[i]] = $(this).find('.fare-button--value-total').text(); }
    });

    let price = Infinity;
    if (Object.keys(priceStrDict).length > 0) {
      for (var key in priceStrDict) {
        let price_ = parseInt(priceStrDict[key], 10);
        if (price_ < price) { price = price_; }
      }
    } else { console.error('There were no prices found!'); }
    console.log('Price: ', price);

    dest.push({
      number: flights,
      stops,
      price
    });
  }
}

function createUrl (from, to, departDate, returnDate, browser) {
  return 'https://www.southwest.com/air/booking/select.html' +
    '?adultPassengersCount=1' +
    '&departureDate=' + dateFormat(departDate, 'yyyy-mm-dd', true) +
    '&departureTimeOfDay=ALL_DAY' +
    '&destinationAirportCode=' + to +
    '&fareType=USD' +
    '&originationAirportCode=' + from +
    '&passengerType=ADULT' +
    '&returnDate=' +
    '&returnTimeOfDay=ALL_DAY' +
    '&seniorPassengersCount=0' +
    '&tripType=oneway';
}

async function getPage (from, to, departDate, returnDate, browser) {
  const page = await browser.newPage();
  try {
    const url = createUrl(from, to, departDate, returnDate);
    console.log('URL: ', url);
    await page.goto(url);

    try {
      await page.waitForSelector('.price-matrix--details-titles');
    } catch (err) {
      const currentUrl = page.url();
      await page.goto('about:blank');
      await page.close();
      throw 'Unable to find flight information on page: ' + currentUrl;
    }

    const html = await page.evaluate(() => document.body.outerHTML);
    await page.goto('about:blank');
    await page.close();
    return html.toString();
  } catch (e) {
    try {
      await page.goto('about:blank');
      await page.close();
    } catch (err) { }
    throw e;
  }
}

module.exports = {
  getPriceForFlight,
  getFlights
};
