const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * Lista de usuários com permissão para usar o bot.
 * - Na primeira execução, é criada a partir de ALLOWED_USERS no .env;
 * - Depois disso, o arquivo data/allowed-users.json é a fonte da verdade
 *   (permite /adduser e /deluser sem editar o .env).
 */

function load() {
  try {
    const raw = fs.readFileSync(config.allowedUsersFile, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.users)) {
      return data.users.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    }
    throw new Error('formato inválido');
  } catch (err) {
    // Arquivo ausente/corrompido: (re)cria semeando pelo .env
    const seeded = [...config.allowedUsersSeed];
    saveList(seeded);
    return seeded;
  }
}

function saveList(users) {
  fs.mkdirSync(path.dirname(config.allowedUsersFile), { recursive: true });
  fs.writeFileSync(config.allowedUsersFile, JSON.stringify({ users }, null, 2));
}

/** Verifica se o usuário tem permissão */
function isAllowed(userId) {
  if (userId === undefined || userId === null) return false;
  return load().includes(Number(userId));
}

/** Lista atual de IDs autorizados */
function list() {
  return [...load()];
}

/** Adiciona um ID (valida formato). Retorna false se já existia. */
function addUser(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`ID inválido: ${userId}`);
  const users = load();
  if (users.includes(id)) return false;
  users.push(id);
  saveList(users);
  return true;
}

/** Remove um ID. Retorna false se não existia. O dono não pode ser removido. */
function removeUser(userId) {
  const id = Number(userId);
  if (config.ownerId !== null && id === config.ownerId) {
    throw new Error('O ID principal (dono) não pode ser removido.');
  }
  const users = load();
  const index = users.indexOf(id);
  if (index === -1) return false;
  users.splice(index, 1);
  saveList(users);
  return true;
}

/** Verifica se o usuário é o dono (primeiro ID de ALLOWED_USERS) */
function isOwner(userId) {
  return config.ownerId !== null && Number(userId) === config.ownerId;
}

module.exports = { isAllowed, list, addUser, removeUser, isOwner };
