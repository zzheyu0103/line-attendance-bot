'use strict';

const dateFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

const taipeiDate = (date = new Date()) => dateFormatter.format(date);
const toMillis = (value) => new Date(`${value.replace(' ', 'T')}+08:00`).getTime();
const addDays = (date, days) => taipeiDate(new Date(new Date(`${date}T12:00:00+08:00`).getTime() + days * 86400000)).slice(0, 10);

function distanceMeters(lat1, lon1, lat2, lon2) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const earthRadius = 6371000;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function shiftHours(start, end) {
  const [startHour, startMinute] = start.split(':').map(Number);
  const [endHour, endMinute] = end.split(':').map(Number);
  let minutes = endHour * 60 + endMinute - startHour * 60 - startMinute;
  if (minutes < 0) minutes += 1440;
  return minutes / 60;
}

module.exports = { taipeiDate, toMillis, addDays, distanceMeters, shiftHours };
