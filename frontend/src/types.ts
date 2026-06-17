export interface User {
  id: string;
  username: string;
  email?: string;
}

export interface Channel {
  id: string;
  name: string;
  description?: string;
  isDM?: boolean;
  createdAt?: string;
}

export interface Message {
  id: string;
  channelId: string;
  senderId: string;
  sender: {
    id: string;
    username: string;
  };
  content?: string;
  fileUrl?: string;
  fileName?: string;
  fileType?: string;
  parentId?: string;
  parent?: Message;
  createdAt: string;
}
