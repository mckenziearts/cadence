import type fr from '../fr';
import accounts from './accounts';
import agent from './agent';
import api from './api';
import core from './core';
import instagram from './instagram';
import linkedin from './linkedin';
import media from './media';
import tiktok from './tiktok';
import youtube from './youtube';

export default { accounts, agent, api, core, instagram, linkedin, media, tiktok, youtube } satisfies typeof fr;
