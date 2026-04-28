export interface User {
  id: string;
  username: string;
}

export interface Channel {
  id: string;
  name: string;
  isDM?: boolean;
}

export interface Message {
  id: string;
  channelId: string;
  senderId: string;
  sender: {
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
